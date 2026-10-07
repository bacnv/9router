import { describe, expect, it, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The usage handler reads the local ledger through cloudflareFreeTier, so it is
// exercised against a throwaway DB seeded with real usage rows.

let tmpDir;
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;

async function freshModules() {
  vi.resetModules();
  return {
    usage: await import("open-sse/services/usage/cloudflare.js"),
    registry: await import("open-sse/providers/registry/cloudflare-ai.js"),
    db: await import("@/lib/db/index.js"),
  };
}

// clef-flash input is $0.090/M; the free allowance is $0.11 = 10,000 neurons.
const TOKENS_UNDER = 200_000; // $0.018 ->  1,636 neurons
const TOKENS_OVER = 1_400_000; // $0.126 -> 11,454 neurons

async function seed(db, name, promptTokens) {
  const conn = await db.createProviderConnection({
    provider: "cloudflare-ai",
    authType: "apikey",
    name,
    apiKey: "cf-test",
    isActive: true,
    providerSpecificData: { accountId: "acct-" + name },
  });
  await db.saveRequestUsage({
    provider: "cloudflare-ai",
    model: "@cf/cloudflare/clef-flash",
    connectionId: conn.id,
    tokens: { prompt_tokens: promptTokens, completion_tokens: 0 },
    status: "ok",
  });
  return conn.id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-cfu-"));
  process.env.DATA_DIR = tmpDir;
  delete globalThis._dbAdapter; // driver caches the adapter on globalThis
});

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  delete globalThis._dbAdapter;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cloudflare usage handler", () => {
  it("reports the day's neurons against the 10,000 free allocation", async () => {
    const { usage, db } = await freshModules();
    const id = await seed(db, "under", TOKENS_UNDER);

    const result = await usage.getCloudflareUsage(id);
    const q = result.quotas["Daily neurons (free)"];

    expect(q.total).toBe(10_000);
    expect(q.used).toBeCloseTo(1636, 0);
    expect(q.remainingPercentage).toBeCloseTo(83.6, 0);
    // Resets at the next 00:00 UTC, never a local midnight
    expect(q.resetAt).toMatch(/T00:00:00\.000Z$/);
  });

  it("shows the billed overage as its own row once past the free tier", async () => {
    const { usage, db } = await freshModules();
    const id = await seed(db, "over", TOKENS_OVER);

    const result = await usage.getCloudflareUsage(id);

    // Free row is clamped at 100% so the bar cannot overflow
    expect(result.quotas["Daily neurons (free)"].used).toBe(10_000);
    expect(result.quotas["Daily neurons (free)"].remainingPercentage).toBe(0);
    // Overage is visible rather than silently swallowed. $0.126 of clef-flash
    // input is 11,454.5 neurons, so 1,454.5 sit past the free 10,000.
    expect(result.quotas["Billed overage"].used).toBeCloseTo(1454.5, 1);
  });

  it("labels the plan by whether the cap is on", async () => {
    const { usage, db } = await freshModules();
    const id = await seed(db, "plan", TOKENS_UNDER);

    await db.updateSettings({ cloudflareFreeOnly: true });
    expect((await usage.getCloudflareUsage(id)).plan).toMatch(/free cap/);

    await db.updateSettings({ cloudflareFreeOnly: false });
    expect((await usage.getCloudflareUsage(id)).plan).toMatch(/billing overage/);
  });

  it("returns a message rather than throwing on a missing connection id", async () => {
    const { usage } = await freshModules();
    const result = await usage.getCloudflareUsage(null);
    expect(result.message).toMatch(/not available/i);
    expect(result.quotas).toBeUndefined();
  });

  it("is registered and opted into the api-key usage path", async () => {
    const { registry, db } = await freshModules();
    expect(registry.default.features.usage).toBe(true);
    // Without usageApikey the usage route rejects apikey connections before
    // reaching the handler, so the Quota page would show nothing at all.
    expect(registry.default.features.usageApikey).toBe(true);

    // Reached through the public dispatcher — the same call the route makes.
    const { getUsageForProvider } = await import("open-sse/services/usage.js");
    const conn = await db.getProviderConnectionById(
      await seed(db, "dispatch", TOKENS_UNDER)
    );
    const result = await getUsageForProvider(conn);
    expect(result.quotas["Daily neurons (free)"].total).toBe(10_000);
  });
});
