// Spending a reset grant/credit refills the limits upstream, but the row that
// blocks the account lives in our DB: `modelLock_<model>` plus testStatus/lastError.
// Nothing on the reset path cleared it, so the quota came back and every request
// kept skipping the account until the stale expiry — reported as "quota is back
// but Claude Code is still blocked".

import { describe, expect, it } from "vitest";
import { buildResetQuotaStateUpdate, isModelLockActive } from "../../open-sse/services/accountFallback.js";

const HOUR = 3600 * 1000;
const future = () => new Date(Date.now() + 5 * 24 * HOUR).toISOString();

const blockedConnection = () => ({
  id: "c1",
  provider: "claude",
  "modelLock_claude-fable-5-2": future(),
  "modelLock_claude-opus-5-5": future(),
  testStatus: "unavailable",
  lastError: "[429]: rate_limit_error",
  errorCode: 429,
  lastErrorAt: new Date().toISOString(),
  backoffLevel: 7,
});

const applied = (conn, update) => ({ ...conn, ...update });

describe("buildResetQuotaStateUpdate", () => {
  it("releases every model lock so the account is selectable again", () => {
    const update = buildResetQuotaStateUpdate(blockedConnection());
    const after = applied(blockedConnection(), update);
    expect(isModelLockActive(after, "claude-fable-5-2")).toBe(false);
    expect(isModelLockActive(after, "claude-opus-5-5")).toBe(false);
  });

  it("clears the error state that the UI renders", () => {
    const update = buildResetQuotaStateUpdate(blockedConnection());
    expect(update).toMatchObject({
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0,
    });
  });

  it("nulls the lock keys rather than deleting them, matching the repo's patch shape", () => {
    const update = buildResetQuotaStateUpdate(blockedConnection());
    expect(update["modelLock_claude-fable-5-2"]).toBeNull();
    expect(update["modelLock_claude-opus-5-5"]).toBeNull();
  });

  it("is a no-op shape for a connection that never failed", () => {
    const healthy = { id: "c2", provider: "claude", testStatus: "active" };
    const update = buildResetQuotaStateUpdate(healthy);
    expect(Object.keys(update).filter((k) => k.startsWith("modelLock_"))).toEqual([]);
    expect(update.testStatus).toBe("active");
  });
});
