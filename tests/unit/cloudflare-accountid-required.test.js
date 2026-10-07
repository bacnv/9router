import { describe, expect, it } from "vitest";
import { normalizeProviderSpecificData } from "@/lib/providerNormalization.js";

// Regression: a Cloudflare connection saved without accountId inserts fine,
// then every request 502s at the executor's {accountId} substitution. It was
// reachable by pasting "name|apiKey" into bulk-add, which omits the third
// field, and by any direct POST /api/providers call.

describe("cloudflare-ai accountId is required at the trust boundary", () => {
  it("accepts an accountId from providerSpecificData", () => {
    const result = normalizeProviderSpecificData(
      "cloudflare-ai",
      {},
      { accountId: "abc123" }
    );
    expect(result.accountId).toBe("abc123");
  });

  it("accepts a flat accountId from the body when providerSpecificData is absent", () => {
    const result = normalizeProviderSpecificData("cloudflare-ai", { accountId: "abc123" });
    expect(result.accountId).toBe("abc123");
  });

  it("throws a 400 when the accountId is missing", () => {
    expect(() => normalizeProviderSpecificData("cloudflare-ai", {})).toThrow(/Account ID/i);
    try {
      normalizeProviderSpecificData("cloudflare-ai", {});
    } catch (e) {
      expect(e.status).toBe(400);
    }
  });

  it("treats a blank or whitespace accountId as missing", () => {
    expect(() => normalizeProviderSpecificData("cloudflare-ai", { accountId: "" })).toThrow();
    expect(() => normalizeProviderSpecificData("cloudflare-ai", { accountId: "   " })).toThrow();
  });

  it("trims a padded accountId rather than storing it raw", () => {
    const result = normalizeProviderSpecificData("cloudflare-ai", {}, { accountId: "  abc123  " });
    expect(result.accountId).toBe("abc123");
  });

  it("leaves every other provider untouched", () => {
    // No accountId requirement, and an empty payload still normalizes to null.
    expect(normalizeProviderSpecificData("deepseek", {})).toBeNull();
    expect(() => normalizeProviderSpecificData("openai", {})).not.toThrow();
  });
});
