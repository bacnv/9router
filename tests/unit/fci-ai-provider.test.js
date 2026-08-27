import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("FCI AI provider", () => {
  const entry = REGISTRY.find((provider) => provider.id === "fci-ai");

  it("registers an OpenAI-compatible API-key provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.alias).toBe("fci");
    expect(PROVIDERS["fci-ai"]).toMatchObject({
      baseUrl: "https://mkp-api.fptcloud.com/chat/completions",
      format: "openai",
    });
    expect(APIKEY_PROVIDERS["fci-ai"]).toBeDefined();
  });

  it("exposes GLM-5.2 and Qwen3.8-27B as the ordered defaults", () => {
    expect(PROVIDER_MODELS.fci.map((model) => model.id)).toEqual([
      "GLM-5.2",
      "Qwen3.8-27B",
    ]);
  });

  it("marks only Qwen3.8-27B as vision-capable", () => {
    expect(getCapabilitiesForModel("fci-ai", "GLM-5.2").vision).toBe(false);
    expect(getCapabilitiesForModel("fci-ai", "Qwen3.8-27B").vision).toBe(true);
    expect(getCapabilitiesForModel("fci", "Qwen3.8-27B").vision).toBe(true);
  });
});
