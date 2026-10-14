import { describe, expect, it } from "vitest";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";

// The API-key `anthropic` provider shares api.anthropic.com with the OAuth `claude`
// provider, so its catalog must list the same models. It had drifted to the 4.x
// generation.
describe("anthropic provider catalog", () => {
  it("mirrors the claude models on the same upstream", () => {
    const ids = getModelsByProviderId("anthropic").map((m) => m.id);
    for (const id of getModelsByProviderId("claude").map((m) => m.id)) {
      expect(ids).toContain(id);
    }
  });
});

// Fable 5 fell through to claude-* pricing ($3/$15 instead of $10/$50), and the two
// rows the claude catalog relied on were missing entirely.
describe("anthropic model metadata", () => {
  it("prices Opus 5 and Fable 5.1 exactly", () => {
    expect(getPricingForModel("anthropic", "claude-opus-5"))
      .toEqual({ input: 5, output: 25, cached: 0.5, reasoning: 25, cache_creation: 6.25 });
    expect(getPricingForModel("anthropic", "claude-fable-5-1"))
      .toEqual({ input: 10, output: 50, cached: 0.25, reasoning: 50, cache_creation: 12.5 });
  });

  it("marks Fable 5 adaptive-always-on", () => {
    expect(getCapabilitiesForModel("anthropic", "claude-fable-5")).toMatchObject({
      thinkingFormat: "claude-adaptive",
      thinkingCanDisable: false,
      contextWindow: 1000000,
    });
  });
});

// Haiku 4.5 and earlier take extended thinking, so the passthrough downgrade still
// rewrites their adaptive request.
describe("normalizeClaudePassthrough adaptive gate", () => {
  it("downgrades Haiku 4.5", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" }, output_config: { effort: "high" } }, "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(out.output_config).toBeUndefined();
  });

  it("leaves sonnet/opus adaptive", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-opus-5-5");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });
});
