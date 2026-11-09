// ChatGPT Free Codex accounts are the one plan the usage API never names: it
// omits plan_type, so the dashboard had no way to label the account or to hide
// the paid-only models upstream rejects with 400. The operator now marks a
// connection from Edit → "ChatGPT Free plan", stored as
// providerSpecificData.chatgptPlanType = "free", and enabling it seeds
// enabledModels from CODEX_FREE_MODELS (the list the model picker, /v1/models
// and account selection already honour).

import { describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
const { getCodexUsage } = await import("open-sse/services/usage/codex.js");
const { CODEX_FREE_MODELS } = await import("open-sse/providers/registry/codex.js");
const REGISTRY_MODELS = (await import("open-sse/providers/registry/codex.js")).default.models;

describe("Codex free plan marker", () => {
  it("every default free model exists in the registry", () => {
    const ids = new Set(REGISTRY_MODELS.map((m) => m.id));
    for (const id of CODEX_FREE_MODELS) expect(ids.has(id)).toBe(true);
  });

  it("labels a free account when the usage API omits plan_type", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rate_limit: { primary_window: { used_percent: 10 } } }),
    });

    const usage = await getCodexUsage("token", null, { chatgptPlanType: "free" });
    expect(usage.plan).toBe("free");
  });

  it("keeps the upstream plan when the API reports one", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ plan_type: "pro", rate_limit: {} }),
    });

    const usage = await getCodexUsage("token", null, { chatgptPlanType: "free" });
    expect(usage.plan).toBe("pro");
  });

  it("falls back to unknown when neither source has a plan", async () => {
    proxyAwareFetch.mockResolvedValue({ ok: true, json: async () => ({ rate_limit: {} }) });

    const usage = await getCodexUsage("token", null, null);
    expect(usage.plan).toBe("unknown");
  });
});
