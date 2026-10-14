import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The trust boundary behind the Custom Headers card.
let tempDir;
let PUT, GET;

const put = (id, body) =>
  PUT(new Request(`http://localhost/api/providers/${id}/overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });

const get = (id) =>
  GET(new Request(`http://localhost/api/providers/${id}/overrides`), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-overrides-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ PUT, GET } = await import("@/app/api/providers/[id]/overrides/route.js"));
});

afterAll(() => {
  delete process.env.DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("provider header overrides", () => {
  it("blocks anthropic-beta — it is computed per request, not a static header", async () => {
    const res = await put("claude", { headers: { "Anthropic-Beta": "user-forced-flag" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot be overridden/i);
  });

  it("blocks it case-insensitively on the apikey anthropic provider too", async () => {
    const res = await put("anthropic", { headers: { "anthropic-beta": "x" } });
    expect(res.status).toBe(400);
  });

  it("still accepts an ordinary header and returns it", async () => {
    const res = await put("anthropic", { headers: { "X-Trace-Id": "abc" } });
    expect(res.status).toBe(200);
    const body = await (await get("anthropic")).json();
    expect(body.headers).toEqual({ "X-Trace-Id": "abc" });
  });

  it("clears the override when the payload carries no headers", async () => {
    await put("anthropic", { headers: {} });
    const body = await (await get("anthropic")).json();
    expect(body.headers).toEqual({});
  });
});
