// Ollama's cloud lane exposes the full level list in the picker but only serves
// the top tier usefully, so those ids carry `reasoningEffortPin` on their
// registry entry. The picker stays complete; the wire send is always the pin.
// This is deliberately separate from thinkingLevels — declaring ["max"] there
// would shrink the picker, which is not what we want.

import { describe, expect, it } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const PINNED = ["deepseek-v4.1-flash:cloud", "deepseek-v4.1-flash:1017-cloud"];
const FULL_RANGE = ["none", "low", "medium", "high", "xhigh", "max"];

const think = (model, intent) => {
  const body = { messages: [], model };
  applyThinking("ollama", model, body, "ollama", intent);
  return body.think;
};

describe("ollama effort pin", () => {
  it.each(PINNED)("%s still offers every level in the picker", (model) => {
    expect(getThinkingLevels("ollama", model)).toEqual(FULL_RANGE);
  });

  it.each(PINNED)("%s sends max for every requested level", (model) => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(think(model, { mode: "level", level })).toBe("max");
    }
    expect(think(model, { mode: "auto" })).toBe("max");
    // The pin is absolute, like Codex's normalizeReasoningEffort for GPT-6 Luna:
    // picking "off" must not leak think:false upstream when the picker offers
    // levels that all mean max.
    expect(think(model, { mode: "none" })).toBe("max");
  });

  it("leaves models without a pin alone", () => {
    expect(think("kimi-k2.5", { mode: "level", level: "low" })).toBe("low");
    expect(think("kimi-k2.5", { mode: "level", level: "max" })).toBe("max");
    expect(think("kimi-k2.5", { mode: "none" })).toBe(false);
  });
});
