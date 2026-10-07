import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Drives POST /api/providers itself: the unit test on the normalizer proves the
// throw, this proves the route turns it into a 400 rather than a 500 and that
// no half-built connection row is left behind.

let tmpDir;
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;

function makeRequest(body) {
  return new Request("http://localhost/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function freshRoute() {
  vi.resetModules();
  return {
    POST: (await import("@/app/api/providers/route.js")).POST,
    db: await import("@/lib/db/index.js"),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-cfpost-"));
  process.env.DATA_DIR = tmpDir;
  delete globalThis._dbAdapter; // driver caches the adapter on globalThis
});

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  delete globalThis._dbAdapter;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/providers — Cloudflare accountId", () => {
  it("rejects a Cloudflare connection with no accountId as a 400", async () => {
    const { POST, db } = await freshRoute();

    const res = await POST(makeRequest({
      provider: "cloudflare-ai",
      apiKey: "cfut_test",
      name: "no-account",
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Account ID/i);

    // The broken row must not exist — that is the whole point of rejecting early.
    const connections = await db.getProviderConnections({ provider: "cloudflare-ai" });
    expect(connections).toHaveLength(0);
  });

  it("accepts the accountId supplied as a flat body field", async () => {
    const { POST, db } = await freshRoute();

    const res = await POST(makeRequest({
      provider: "cloudflare-ai",
      apiKey: "cfut_test",
      name: "with-account",
      accountId: "acct-flat",
    }));

    expect(res.status).toBe(201);
    const connections = await db.getProviderConnections({ provider: "cloudflare-ai" });
    expect(connections).toHaveLength(1);
    expect(connections[0].providerSpecificData.accountId).toBe("acct-flat");
  });

  it("still creates other providers without an accountId", async () => {
    const { POST, db } = await freshRoute();

    const res = await POST(makeRequest({
      provider: "deepseek",
      apiKey: "sk-test",
      name: "ds",
    }));

    expect(res.status).toBe(201);
    expect(await db.getProviderConnections({ provider: "deepseek" })).toHaveLength(1);
  });
});
