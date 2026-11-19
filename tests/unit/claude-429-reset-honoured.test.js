// An exhausted Claude account must be parked until its window actually resets.
//
// Two separate breaks produced the same symptom (hang retried 167 times in 6h):
//   1. the 429 body carries no reset time, and the default parser ignored the
//      `anthropic-ratelimit-unified-*-reset` header, so the lock fell back to the
//      error-rule backoff — 2 seconds;
//   2. even with a reset, `markAccountUnavailable` truncated it to
//      MAX_RATE_LIMIT_COOLDOWN_MS (30 min), so a 5h window was retried 10 times.

import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const HOUR = 3600 * 1000;

const response429 = (headers) => ({
  status: 429,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

describe("DefaultExecutor.parseError — claude 429 reset", () => {
  const executor = new DefaultExecutor("claude");
  const body = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "would exceed your account's rate limit" } });

  it("takes the reset of the window the 429 names", () => {
    const reset = Math.floor((Date.now() + 5 * HOUR) / 1000);
    const parsed = executor.parseError(
      response429({
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-reset": String(reset),
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-7d-reset": String(reset + 999),
      }),
      body,
    );
    expect(parsed.resetsAtMs).toBe(reset * 1000);
  });

  it("ignores a window that still reports allowed", () => {
    const reset = Math.floor((Date.now() + 5 * HOUR) / 1000);
    const parsed = executor.parseError(
      response429({
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-5h-reset": String(reset),
      }),
      body,
    );
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("falls back to retry-after when no unified window is exhausted", () => {
    const before = Date.now();
    const parsed = executor.parseError(response429({ "retry-after": "120" }), body);
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 120 * 1000);
  });

  it("leaves a non-429 alone", () => {
    const parsed = executor.parseError(
      { status: 500, headers: { get: () => null } },
      "boom",
    );
    expect(parsed.resetsAtMs).toBeUndefined();
    expect(parsed.status).toBe(500);
  });
});
