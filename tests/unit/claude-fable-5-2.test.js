// Claude Fable 5.2 must be routable the same way 5.1 is: present in both
// Claude registries, carrying the claude-adaptive thinking shape (thinking.type
// "disabled" is a 400 upstream), and reachable as an alias-qualified model id.

import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";

const MODEL = "claude-fable-5-2";

describe("Claude Fable 5.2", () => {
  it.each(["cc", "anthropic"])("is listed on the %s registry", (alias) => {
    const ids = (PROVIDER_MODELS[alias] || []).map((m) => m.id);
    expect(ids).toContain(MODEL);
  });

  it("matches Fable 5.1's capabilities", () => {
    const caps = getCapabilitiesForModel("cc", MODEL);
    expect(caps.thinkingFormat).toBe("claude-adaptive");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(128000);
    expect(caps).toEqual(getCapabilitiesForModel("cc", "claude-fable-5-1"));
  });

  it("exposes the adaptive thinking levels", () => {
    expect(getThinkingLevels("cc", MODEL)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("is priced, not treated as an unknown model", () => {
    expect(getPricingForModel("cc", MODEL).output).toBeGreaterThan(0);
  });

  it("routes the same wire format as Fable 5.1", () => {
    // null means "no explicit targetFormat override" — the provider transport decides.
    expect(getModelTargetFormat("cc", MODEL)).toEqual(getModelTargetFormat("cc", "claude-fable-5-1"));
  });
});
