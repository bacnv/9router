import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("FPT Token API provider", () => {
  const entry = REGISTRY.find((provider) => provider.id === "fci-neo");

  it("registers an OpenAI-compatible API-key provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.alias).toBe("fcineo");
    expect(PROVIDERS["fci-neo"]).toMatchObject({
      baseUrl: "https://token-api.fpt.ai/v1/chat/completions",
      format: "openai",
    });
    expect(APIKEY_PROVIDERS["fci-neo"]).toBeDefined();
  });

  it("lists every chat model the gateway serves, and none of the non-chat ones", () => {
    const ids = PROVIDER_MODELS.fcineo.map((model) => model.id);
    expect(ids).toHaveLength(25);
    // Multi-vendor ids keep the upstream's routing prefix, so the colon must survive.
    expect(ids).toContain("Alibaba:Kimi-K3");
    expect(ids).toContain("Z.ai:GLM-5.3");
    // Embedding, reranker and TTS rides the same gateway but not this provider.
    for (const excluded of ["Vietnamese_Embedding", "multilingual-e5-large", "bge-reranker-v2-m3", "FPT.AI-VITs", "FPT.TTS-pro"]) {
      expect(ids).not.toContain(excluded);
    }
  });
});

// The gateway carries Anthropic/Google/Z.ai-named models on one OpenAI-compatible
// wire. Their capability patterns would otherwise select the family's native
// thinking format, which sends fields this upstream rejects — probe before the
// transport pin showed enable_thinking/thinking/generationConfig leaking through.
describe("FPT Token API thinking wire", () => {
  const REASONING_MODELS = ["Qwen3.8-27B", "GLM-5.2", "Alibaba:Kimi-K3", "Minimax:Minimax-M3", "Google:Gemini-3.5-Flash"];

  it.each(REASONING_MODELS)("sends only reasoning_effort for %s", (id) => {
    const body = { reasoning_effort: "high" };
    applyThinking("openai", id, body, "fci-neo");
    expect(Object.keys(body)).toEqual(["reasoning_effort"]);
    expect(body.reasoning_effort).toBe("high");
  });

  it("pins the wire on the transport so the family pattern cannot win", () => {
    expect(PROVIDERS["fci-neo"].thinkingFormat).toBe("openai");
    // The per-model table still reports the family format — resolveFormat prefers
    // the transport pin, which is exactly what keeps the field off the wire.
    expect(getCapabilitiesForModel("fci-neo", "Google:Gemini-3.5-Flash").thinkingFormat).toBe("gemini-level");
  });
});
