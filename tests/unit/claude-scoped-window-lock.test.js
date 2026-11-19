// A Claude 429 carries no reset hint at all — verified against a live exhausted
// account: `x-should-retry: true`, body `{"type":"rate_limit_error","message":"Error"}`,
// no `retry-after`, no `anthropic-ratelimit-unified-*-reset`.
//
// The reset exists, just on another endpoint: the OAuth usage API reports
// model-scoped weekly limits as `{ kind: "weekly_scoped", percent: 100,
// resets_at, scope: { model: { display_name: "Fable" } } }`, which
// getClaudeUsage surfaces as the quota row `weekly fable (7d)`.
//
// Without that lookup the lock falls back to the error-rule backoff (2s) and the
// combo retries an exhausted model for the rest of its window — 167 times in 6h
// observed on a real account.

import { describe, expect, it, vi, beforeEach } from "vitest";

const usage = vi.hoisted(() => ({ getUsageForProvider: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => usage);
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ name: "Claude Fable 5.2" }),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({ info: () => {}, warn: () => {} }));

const { resolveClaudeQuotaReset } = await import("../../src/sse/services/claudeQuotaError.js");

const H = 3600 * 1000;
const creds = { connectionId: "conn-1", accessToken: "tok" };

describe("resolveClaudeQuotaReset", () => {
  beforeEach(() => usage.getUsageForProvider.mockReset());

  it("returns the model-scoped weekly reset when that window is spent", async () => {
    const weekReset = new Date(Date.now() + 5 * 24 * H).toISOString();
    usage.getUsageForProvider.mockResolvedValue({
      quotas: {
        "session (5h)": { remainingPercentage: 60, resetAt: new Date(Date.now() + 2 * H).toISOString() },
        "weekly (7d)": { remainingPercentage: 27, resetAt: new Date(Date.now() + 5 * 24 * H).toISOString() },
        "weekly fable (7d)": { remainingPercentage: 0, resetAt: weekReset },
      },
    });
    expect(await resolveClaudeQuotaReset(creds, "claude-fable-5-2")).toBe(new Date(weekReset).getTime());
  });

  it("returns null when nothing is exhausted, so the caller keeps its normal handling", async () => {
    usage.getUsageForProvider.mockResolvedValue({
      quotas: { "weekly fable (7d)": { remainingPercentage: 40, resetAt: new Date(Date.now() + H).toISOString() } },
    });
    expect(await resolveClaudeQuotaReset(creds, "claude-fable-5-2")).toBeNull();
  });

  it("falls back to any exhausted window when the model has no scoped row", async () => {
    const reset = new Date(Date.now() + 3 * H).toISOString();
    usage.getUsageForProvider.mockResolvedValue({
      quotas: { "session (5h)": { remainingPercentage: 0, resetAt: reset } },
    });
    expect(await resolveClaudeQuotaReset(creds, "claude-opus-5-5")).toBe(new Date(reset).getTime());
  });

  it("ignores an expired reset", async () => {
    usage.getUsageForProvider.mockResolvedValue({
      quotas: { "weekly fable (7d)": { remainingPercentage: 0, resetAt: new Date(Date.now() - H).toISOString() } },
    });
    expect(await resolveClaudeQuotaReset(creds, "claude-fable-5-2")).toBeNull();
  });

  it("returns null when the usage API answers with no quota block", async () => {
    // Covers the failure shape that reaches the request path: getUsageForProvider
    // folds its own errors into `{ message }`, so a failed lookup arrives here as
    // a result without `quotas` rather than a rejection.
    usage.getUsageForProvider.mockResolvedValue({ message: "Claude usage unavailable (429)." });
    expect(await resolveClaudeQuotaReset(creds, "claude-fable-5-2")).toBeNull();
  });

  it("returns null without an access token", async () => {
    expect(await resolveClaudeQuotaReset({ connectionId: "x" }, "claude-fable-5-2")).toBeNull();
    expect(usage.getUsageForProvider).not.toHaveBeenCalled();
  });
});
