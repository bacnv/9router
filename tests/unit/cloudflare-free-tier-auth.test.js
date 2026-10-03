import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// End-to-end guard check: seed a throwaway DB with today's cloudflare usage,
// then call the real getProviderCredentials and assert it refuses the account.
// Runs against the real auth.js, so it proves the wiring — not just the module.

let tmpDir;
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;

async function freshModules() {
  // Module-level caches (db adapter, pricing, usage TTL) must not leak across cases.
  vi.resetModules();
  return {
    auth: await import("@/sse/services/auth.js"),
    db: await import("@/lib/db/index.js"),
    guard: await import("@/lib/cloudflareFreeTier.js"),
  };
}

// createProviderConnection mints its own uuid; return it so usage rows can
// be attached to the row that actually exists.
async function seedConnection(db, name) {
  const conn = await db.createProviderConnection({
    provider: "cloudflare-ai",
    authType: "apikey",
    name,
    apiKey: "cf-test-key",
    isActive: true,
    providerSpecificData: { accountId: "acct-" + name },
  });
  return conn.id;
}

// saveRequestUsage recomputes cost from the pricing table, so seed tokens and
// let the real pipeline (tokens -> PROVIDER_PRICING -> cost -> neurons) run.
// clef-flash input is $0.090/M, so promptTokens * 0.09 / 1e6 dollars.
// The free allowance is $0.11 = 10,000 neurons, i.e. ~1,222,222 input tokens.
const TOKENS_OVER = 1_400_000; // $0.126 -> 11,454 neurons, past the cap
const TOKENS_UNDER = 200_000;  // $0.018 -> 1,636 neurons, well under

async function seedUsage(db, connectionId, promptTokens) {
  await db.saveRequestUsage({
    provider: "cloudflare-ai",
    model: "@cf/cloudflare/clef-flash",
    connectionId,
    tokens: { prompt_tokens: promptTokens, completion_tokens: 0 },
    status: "ok",
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-cf-"));
  process.env.DATA_DIR = tmpDir;
  // driver.js caches the adapter on globalThis to survive Next hot-reload, so
  // resetModules() alone would leave every case pointed at the same database.
  delete globalThis._dbAdapter;
});

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  delete globalThis._dbAdapter;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("free-tier cap end-to-end through getProviderCredentials", () => {
  it("serves the account while under the allocation", async () => {
    const { auth, db } = await freshModules();
    const id = await seedConnection(db, "under");
    await seedUsage(db, id, TOKENS_UNDER);

    const creds = await auth.getProviderCredentials("cloudflare-ai", new Set(), "@cf/cloudflare/clef-flash");
    expect(creds?.connectionId).toBe(id);
    expect(creds?.allRateLimited).toBeFalsy();
  });

  it("refuses the account once today's allocation is spent", async () => {
    const { auth, db } = await freshModules();
    const id = await seedConnection(db, "over");
    await seedUsage(db, id, TOKENS_OVER); // past the free 10,000
    await db.updateSettings({ cloudflareFreeOnly: true });

    const creds = await auth.getProviderCredentials("cloudflare-ai", new Set(), "@cf/cloudflare/clef-flash");
    expect(creds?.allRateLimited).toBe(true);
    expect(creds?.lastError).toMatch(/free neuron allocation/i);
    // Reported as a reset, and the retry lands on the next 00:00 UTC
    expect(new Date(creds.retryAfter).toISOString()).toMatch(/T00:00:00\.000Z$/);
  });

  it("keeps serving past the allocation when the cap is off", async () => {
    const { auth, db } = await freshModules();
    const id = await seedConnection(db, "off");
    await seedUsage(db, id, TOKENS_OVER * 4); // way over, but cap disabled
    await db.updateSettings({ cloudflareFreeOnly: false });

    const creds = await auth.getProviderCredentials("cloudflare-ai", new Set(), "@cf/cloudflare/clef-flash");
    expect(creds?.connectionId).toBe(id);
  });

  it("falls through to the account still under the cap", async () => {
    const { auth, db } = await freshModules();
    const overId = await seedConnection(db, "over");
    const underId = await seedConnection(db, "under");
    await seedUsage(db, overId, TOKENS_OVER);  // over
    await seedUsage(db, underId, TOKENS_UNDER); // under
    await db.updateSettings({ cloudflareFreeOnly: true });

    const creds = await auth.getProviderCredentials("cloudflare-ai", new Set(), "@cf/cloudflare/clef-flash");
    expect(creds?.connectionId).toBe(underId);
  });

  it("counts yesterday's spend as already reset", async () => {
    const { auth, db, guard } = await freshModules();
    const id = await seedConnection(db, "yesterday");
    await db.saveRequestUsage({
      provider: "cloudflare-ai",
      model: "@cf/cloudflare/clef-flash",
      connectionId: id,
      tokens: { prompt_tokens: TOKENS_OVER, completion_tokens: 0 },
      // over the cap, but stamped before today's UTC window
      status: "ok",
      timestamp: new Date(new Date(guard.utcDayStart()).getTime() - 60_000).toISOString(),
    });
    await db.updateSettings({ cloudflareFreeOnly: true });

    const creds = await auth.getProviderCredentials("cloudflare-ai", new Set(), "@cf/cloudflare/clef-flash");
    expect(creds?.connectionId).toBe(id);
  });
});
