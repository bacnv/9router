// Ollama's cloud lane flattens the intermediate reasoning tiers, so a model
// pinned to a single level on its registry entry must send that level no matter
// what the client asked for — otherwise the picker offers a choice with no
// effect. Only single-entry pins are enforced; a model declaring a real range
// keeps the client's request.

import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const think = (model, intent) => {
  const body = { messages: [], model };
  applyThinking("ollama", model, body, "ollama", intent);
  return body.think;
};

describe("ollama thinking: single-level pins", () => {
  const PINNED = ["deepseek-v4.1-flash:cloud", "deepseek-v4.1-flash:1017-cloud"];

  it.each(PINNED)("%s sends max for every requested level", (model) => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(think(model, { mode: "level", level })).toBe("max");
    }
    expect(think(model, { mode: "auto" })).toBe("max");
  });

  it.each(PINNED)("%s pins even an explicit disable to max", (model) => {
    // Same rule as Codex's normalizeReasoningEffort for GPT-6 Luna: a single-level
    // pin is absolute, "none" included. Disable would otherwise send think:false
    // and make the picker's single option a lie.
    expect(think(model, { mode: "none" })).toBe("max");
  });

  it("leaves models with a real level range alone", () => {
    expect(think("kimi-k2.5", { mode: "level", level: "low" })).toBe("low");
    expect(think("kimi-k2.5", { mode: "level", level: "max" })).toBe("max");
    expect(think("glm-5", { mode: "level", level: "high" })).toBe("high");
  });
});
