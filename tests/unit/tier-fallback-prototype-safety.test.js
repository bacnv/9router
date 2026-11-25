// `level` comes straight from client input — reasoning_effort, output_config.effort,
// or a `model(level)` suffix. The tier lookup table must not answer inherited
// Object.prototype members: `TIER_FALLBACKS["constructor"]` on a plain object
// literal returns the Object constructor, and the tier walk then throws
// ("tiers.entries is not a function") instead of falling back to the base model.

import { describe, expect, it } from "vitest";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";

const POISON = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];

describe("getModelUpstreamId — client-supplied level is prototype-safe", () => {
  it.each(POISON)("does not throw for reasoning_effort %s", (level) => {
    expect(() => getModelUpstreamId("kr", "claude-opus-5.5", { reasoning_effort: level })).not.toThrow();
  });

  it("still resolves the base model when the level is unknown", () => {
    for (const level of POISON) {
      expect(getModelUpstreamId("kr", "claude-opus-5.5", { reasoning_effort: level })).toBe("claude-opus-5.5");
    }
  });

  it("keeps the real tier fallbacks working", () => {
    // max → xhigh → high: kr has no -max, so the walk must land on a real model.
    const id = getModelUpstreamId("kr", "claude-opus-5.5", { reasoning_effort: "max" });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("is safe when the level arrives through a model suffix", () => {
    expect(() => getModelUpstreamId("kr", "claude-opus-5.5(constructor)")).not.toThrow();
  });
});
