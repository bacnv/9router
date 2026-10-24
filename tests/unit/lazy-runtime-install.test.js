import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The runtime dir is derived from DATA_DIR at import time, so each test gets a
// throwaway one. spawn is stubbed: what is under test is the manifest we put
// there, not npm itself.
const spawned = [];
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: (...args) => {
    spawned.push({ cmd: args[0], args: args[1], opts: args[2] });
    const child = {
      stderr: { on: () => {} },
      on: (event, fn) => { if (event === "close") queueMicrotask(() => fn(0)); },
    };
    return child;
  },
}));

let dataDir;
// A name that can't resolve locally, so load() falls through to npmInstall —
// the branch that has to write the manifest. playwright-core itself *is*
// installed on a dev machine and would short-circuit at step 1.
const MISSING_PKG = "@9router-test/definitely-not-installed";

beforeEach(() => {
  vi.resetModules();
  spawned.length = 0;
  dataDir = mkdtempSync(path.join(tmpdir(), "9router-runtime-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("lazyRuntime on-demand install", () => {
  it("writes its own package.json before spawning npm", async () => {
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    await loadRuntimeDep(MISSING_PKG).catch(() => {});

    const runtimeDir = path.join(dataDir, "runtime");
    const manifest = path.join(runtimeDir, "package.json");
    expect(existsSync(manifest)).toBe(true);
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toMatchObject({ private: true });

    const install = spawned.find((s) => s.args?.includes("install"));
    expect(install).toBeDefined();
    // Without a manifest of its own, npm walks up to the app's package.json,
    // reports "up to date" and installs nothing into the runtime dir.
    expect(install.opts.cwd).toBe(runtimeDir);
  });

  it("keeps an existing package.json untouched", async () => {
    const runtimeDir = path.join(dataDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const manifest = path.join(runtimeDir, "package.json");
    const owner = JSON.stringify({ name: "mine", private: true, dependencies: { x: "1.0.0" } });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(manifest, owner);

    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    await loadRuntimeDep(MISSING_PKG).catch(() => {});

    expect(readFileSync(manifest, "utf8")).toBe(owner);
  });
});
