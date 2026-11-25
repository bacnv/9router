// Deadlock: a lock is written from a 429, and account selection skips locked
// connections — so no request is ever sent from that account, no success ever runs
// clearAccountError, and the stale lock outlives the quota it was written for. The
// quota panel's refresh is the only lever the user has; reading usage must release
// the account when the provider says there is room again.

import { describe, expect, it } from "vitest";
import { locksContradictedByUsage } from "../../open-sse/services/accountFallback.js";

const HOUR = 3600 * 1000;
const future = () => new Date(Date.now() + 48 * HOUR).toISOString();
const past = () => new Date(Date.now() - HOUR).toISOString();

const conn = (locks) => ({ id: "c1", provider: "claude", ...locks });

describe("locksContradictedByUsage", () => {
  it("releases a fable lock once the fable window has room again", () => {
    const c = conn({ "modelLock_claude-fable-5-2": future() });
    // The real shape: 0% remaining means exhausted, anything above means room.
    expect(locksContradictedByUsage(c, { "weekly fable (7d)": { remainingPercentage: 100 } }))
      .toEqual(["modelLock_claude-fable-5-2"]);
  });

  it("keeps the lock when the window is still exhausted", () => {
    const c = conn({ "modelLock_claude-fable-5-2": future() });
    expect(locksContradictedByUsage(c, { "weekly fable (7d)": { remainingPercentage: 0 } })).toEqual([]);
  });

  it("falls back to the account-wide windows when the plan has no scoped row", () => {
    const c = conn({ "modelLock_claude-opus-5-5": future() });
    expect(locksContradictedByUsage(c, { "session (5h)": { remainingPercentage: 18 }, "weekly (7d)": { remainingPercentage: 54 } }))
      .toEqual(["modelLock_claude-opus-5-5"]);
  });

  it("does not release anything when usage carries no usable bucket", () => {
    const c = conn({ "modelLock_claude-fable-5-2": future() });
    expect(locksContradictedByUsage(c, {})).toEqual([]);
    expect(locksContradictedByUsage(c, null)).toEqual([]);
  });

  it("ignores already-expired locks (lazy cleanup owns those) and account-wide locks", () => {
    const c = conn({
      "modelLock_claude-fable-5-2": past(),
      "modelLock___all": future(),
    });
    expect(locksContradictedByUsage(c, { "weekly fable (7d)": { remainingPercentage: 100 } })).toEqual([]);
  });

  it("only releases the model the usage actually speaks for", () => {
    const c = conn({
      "modelLock_claude-fable-5-2": future(),
      "modelLock_claude-sonnet-5-5": future(),
    });
    // No sonnet-scoped row and no account-wide rows → sonnet stays locked; fable is freed.
    expect(locksContradictedByUsage(c, { "weekly fable (7d)": { remainingPercentage: 100 } }))
      .toEqual(["modelLock_claude-fable-5-2"]);
  });
});
