// Lazy loader for heavy optional runtime deps (playwright-core, wreq-js).
//
// They are devDependencies only, so end-user installs stay small. On first
// use the package is downloaded into <DATA_DIR>/runtime (same pattern as
// cli/hooks/sqliteRuntime.js) and imported from there. Resolution order:
// app node_modules (dev / traced standalone) → runtime dir → npm install.
//
// Never throws at import time of THIS module — failures surface from
// loadRuntimeDep() with a manual-install hint.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json devDependencies.
const LAZY_DEP_VERSIONS = {
  "playwright-core": "^1.62.1",
  "wreq-js": "^3.2.0",
};

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

// A static node:module import gets stubbed by the server bundler, so
// createRequire must be fetched at runtime for published builds to work.
let createRequirePromise;
function getCreateRequire() {
  createRequirePromise ??= import(/* webpackIgnore: true */ "node:module")
    .then((mod) => mod.createRequire || mod.default?.createRequire);
  return createRequirePromise;
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

function npmInstall(pkg, version) {
  const cwd = getRuntimeDir();
  fs.mkdirSync(cwd, { recursive: true });
  // Without a manifest here npm walks UP to the app's package.json, treats /app
  // as the project root, prints "up to date" and installs nothing — the runtime
  // dir stays empty and every later resolve fails. Own the manifest instead.
  const manifest = path.join(cwd, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({ name: "9router-runtime", private: true }, null, 2) + "\n");
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-audit", "--no-fund", "--prefer-online", `${pkg}@${version}`];
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, stderr: String(error.message || error) }));
    child.on("close", (status) => resolve({ ok: status === 0, stderr }));
  });
}

async function installIntoRuntime(pkg, version) {
  const dir = getRuntimeDir();
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    const reason = (res.stderr.match(/npm ERR! ?(.+)/) || [])[1] || res.stderr.split("\n").filter(Boolean).pop() || "unknown npm error";
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${String(reason).slice(0, 160)}) — ` +
      `install it manually: cd "${dir}" && npm install ${pkg}@${version}`
    );
  }
}

const inflight = new Map();

// Every import() into the runtime dir needs webpackIgnore: without it webpack
// replaces the call with a stub that throws "Cannot find module '<url>'" — the
// URL is not in the bundle's module map, so a runtime-installed path can never
// load.
async function runtimeImport(pkg) {
  const createRequire = await getCreateRequire();
  const runtimeRequire = createRequire(path.join(getRuntimeDir(), "package.json"));
  return import(/* webpackIgnore: true */ pathToFileURL(runtimeRequire.resolve(pkg)).href);
}

async function load(pkg) {
  // 1) Resolvable from the app install (dev machine / traced standalone).
  try {
    return await import(/* webpackIgnore: true */ pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 2) Already present in the runtime dir from a previous install.
  try {
    return await runtimeImport(pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 3) Download on demand, then import from the runtime dir.
  const version = LAZY_DEP_VERSIONS[pkg] || "latest";
  await installIntoRuntime(pkg, version);
  try {
    return await runtimeImport(pkg);
  } catch (error) {
    // npm exits 0 even on partially-extracted installs; wipe and retry once.
    if (!isModuleMissing(error)) throw error;
    fs.rmSync(path.join(getRuntimeDir(), "node_modules", pkg), { recursive: true, force: true });
    await installIntoRuntime(pkg, version);
    return runtimeImport(pkg);
  }
}

export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    // `load` always returns an ESM namespace. These deps are CommonJS, so their
    // real exports sit on `default` — callers that destructure (e.g.
    // `const { chromium } = await loadRuntimeDep("playwright-core")`) would
    // otherwise get undefined and fail with "cannot read properties of
    // undefined (reading 'launchPersistentContext')". Unwrap the CJS shape.
    const promise = load(pkg).then((mod) => mod?.default ?? mod);
    inflight.set(pkg, promise.finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
