import { describe, expect, it, vi, afterEach } from "vitest";

// The usage handler fetches through proxyAwareFetch, which captures globalThis.fetch
// at module load — mocking fetch afterwards would never reach it.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getEmbeddingAdapter } from "../../open-sse/handlers/embeddingProviders/index.js";
import { getSyntheticUsage } from "../../open-sse/services/usage/synthetic.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { liftReasoningAliases } from "../../open-sse/translator/concerns/reasoning.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Synthetic (synthetic.new) — OpenAI-compatible open-model subscription.
// Every expectation below was probed live against the API on 2026-10-27:
// /v1/models for the catalogue, /v2/quotas for the key probe, and one chat
// request per effort value to find the per-model `reasoning_effort` enums.

const P = "synthetic";

describe("synthetic provider wiring", () => {
  it("resolves the syn alias and the provider id", () => {
    expect(resolveProviderAlias("syn")).toBe(P);
    expect(resolveProviderAlias(P)).toBe(P);
  });

  it("serves chat from the documented v1 base and probes the key via /v2/quotas", () => {
    expect(PROVIDERS[P].baseUrl).toBe("https://api.synthetic.new/v1/chat/completions");
    // /v1/models answers 200 for any Bearer, so it cannot validate a key.
    expect(PROVIDERS[P].validateUrl).toBe("https://api.synthetic.new/v2/quotas");
    expect(PROVIDERS[P].usage.url).toBe("https://api.synthetic.new/v2/quotas");
  });

  it("lifts upstream `reasoning` into reasoning_content for OpenAI-shaped clients", () => {
    expect(PROVIDERS[P].quirks.reasoningAliasFields).toBe(true);
    expect(liftReasoningAliases({ reasoning: "x" }).reasoning_content).toBe("x");
    // A delta that already carries the canonical field is left untouched.
    expect(liftReasoningAliases({ reasoning_content: "keep" })).toEqual({ reasoning_content: "keep" });
  });

  it("keeps the hf: / syn: ids verbatim in the catalog", () => {
    const ids = PROVIDER_MODELS.syn.map((m) => m.id);
    expect(ids).toContain("syn:large:text");
    expect(ids).toContain("hf:Qwen/Qwen3.8-27B");
  });
});

describe("synthetic thinking levels mirror the upstream effort enum", () => {
  it.each([
    ["syn:large:text", "max"],
    ["hf:deepseek-ai/DeepSeek-V4.1-Flash", "max"],
    ["hf:zai-org/GLM-5.3", "max"],
    ["hf:moonshotai/Kimi-K3", "max"],
    ["hf:Qwen/Qwen3.8-27B", "xhigh"],
  ])("%s: %s reaches the wire unchanged", (model, effort) => {
    const out = applyThinking(FORMATS.OPENAI, model, { reasoning_effort: effort }, P);
    expect(out.reasoning_effort).toBe(effort);
  });

  it("clamps max to xhigh where the model omits it (400 upstream)", () => {
    for (const model of ["syn:small:text", "hf:openai/gpt-oss-120b", "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4"]) {
      expect(getThinkingLevels(P, model)).not.toContain("max");
      const out = applyThinking(FORMATS.OPENAI, model, { reasoning_effort: "max" }, P);
      expect(out.reasoning_effort).toBe("xhigh");
    }
  });

  it("uses the OpenAI effort vocabulary, not a vendor family format", () => {
    // GLM-5.3 on its own provider resolves to zai's ["thinking"]; over Synthetic
    // the wire is reasoning_effort, so the levels must be effort names.
    expect(getCapabilitiesForModel(P, "hf:zai-org/GLM-5.3").thinkingFormat).toBe(null);
    expect(getThinkingLevels(P, "hf:zai-org/GLM-5.3")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels(P, "hf:zai-org/GLM-5.3")).not.toContain("thinking");
  });

  it("declares context and output limits from the catalogue", () => {
    expect(getCapabilitiesForModel(P, "hf:Qwen/Qwen3.8-27B")).toMatchObject({
      vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536,
    });
    expect(getCapabilitiesForModel(P, "syn:small:text")).toMatchObject({ vision: false, contextWindow: 196608 });
  });

  it("prices the aliases at the underlying model's rate", () => {
    expect(getPricingForModel(P, "syn:large:vision")).toMatchObject({ input: 3, output: 15 });
    expect(getPricingForModel(P, "hf:zai-org/GLM-5.3-Flash")).toMatchObject({ input: 0.15, output: 0.5 });
  });
});

describe("synthetic embeddings", () => {
  it("uses the OpenAI-compatible adapter pointed at /v1/embeddings", () => {
    const a = getEmbeddingAdapter(P);
    expect(a).toBeTruthy();
    expect(a.buildUrl()).toBe("https://api.synthetic.new/v1/embeddings");
    expect(a.buildHeaders({ apiKey: "k" })).toMatchObject({ Authorization: "Bearer k" });
    expect(a.buildBody("hf:nomic-ai/nomic-embed-text-v1.5", { input: "hi" })).toEqual({
      model: "hf:nomic-ai/nomic-embed-text-v1.5", input: "hi",
    });
  });
});

describe("synthetic usage rows", () => {
  afterEach(() => vi.clearAllMocks());

  it("turns the request window and the weekly plan into percentage rows", async () => {
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({
      subscription: { limit: 500, requests: 125, renewsAt: "2026-10-27T08:44:04.756Z" },
      search: { hourly: { limit: 250, requests: 0, renewsAt: "2026-10-27T04:44:04.757Z" } },
      planWeeklyLimit: { percentRemaining: 86.8, nextRegenAt: "2026-10-27T06:14:49.000Z" },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const usage = await getSyntheticUsage("syn_test");
    expect(usage.plan).toBe("Synthetic");
    expect(usage.quotas["Subscription requests"]).toMatchObject({
      used: 125, total: 500, remaining: 375, remainingPercentage: 75, resetAt: "2026-10-27T08:44:04.756Z",
    });
    expect(usage.quotas["Plan window (weekly)"]).toMatchObject({ used: 13.2, remainingPercentage: 86.8 });
  });

  it("reports a bad key instead of throwing", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("{\"error\":\"Invalid API Key.\"}", { status: 401 }));
    expect((await getSyntheticUsage("bad")).message).toMatch(/invalid or expired/i);
  });

  it("asks for a key when none is stored", async () => {
    expect((await getSyntheticUsage(null)).message).toMatch(/not available/i);
  });
});
