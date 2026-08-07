# Ollama Cloud Auto-Ping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-connection Ollama Cloud auto-ping using `gemma4`, scheduled five hours after the last successful ping and skipped when session or weekly quota is exhausted.

**Architecture:** Extend the existing shared quota scheduler instead of adding another timer. Give each provider handler a connection-aware usage adapter and ping sender; Ollama uses API-key authentication and an interval trigger because its usage API has no reset timestamp. Extend the two existing UI entry points and settings-trigger paths with the same `ollamaAutoPing` JSON contract.

**Tech Stack:** Plain JavaScript ESM, Next.js App Router, React, existing `DefaultExecutor`, Vitest.

## Global Constraints

- Model is exactly `gemma4`; do not add fallback models.
- Ping request is non-streaming with prompt `hi` and `options.num_predict: 1`.
- Schedule each next attempt five hours after `lastPingAt`; a failed ping must not update that field.
- Require both `Session (5h)` and `Weekly (7d)` to be present and above 0% remaining.
- Reuse the existing 15-minute failure cooldown and connection proxy configuration.
- Auto-ping remains opt-in per active Ollama API-key connection.
- Do not change quota display semantics or add a database migration/dependency.

## File Structure

- Modify `tests/unit/quota-auto-ping.test.js`: scheduler, quota, request, cooldown, and timer regression tests.
- Modify `src/shared/constants/config.js`: declarative Ollama schedule/request configuration.
- Modify `src/shared/services/quotaAutoPing.js`: connection-aware usage calls, API-key eligibility, interval trigger, quota guard, and Ollama request.
- Modify `src/shared/services/initializeApp.js`: start scheduler at boot when Ollama is the only opted-in provider.
- Modify `src/app/api/settings/route.js`: reconfigure scheduler immediately when `ollamaAutoPing` changes.
- Modify `src/app/(dashboard)/dashboard/providers/[id]/page.js`: expose the per-key toggle on the Ollama provider page.
- Modify `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`: show Ollama-specific tooltip copy.
- Modify `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js`: expose and persist the per-key toggle on Usage.

---

### Task 1: Ollama Scheduler Behavior

**Files:**
- Modify: `tests/unit/quota-auto-ping.test.js:19-372`
- Modify: `src/shared/constants/config.js:65-93`
- Modify: `src/shared/services/quotaAutoPing.js:4-313`

**Interfaces:**
- Consumes: `getOllamaUsage(apiKey, providerSpecificData, proxyOptions)` from `open-sse/services/usage/misc.js`.
- Consumes: `getExecutor("ollama").execute({ model, stream, credentials, proxyOptions, log, body })`.
- Produces: `QUOTA_AUTOPING_CONFIG.providers.ollama` with `settingsKey`, `authType`, `pingIntervalMs`, `requiredQuotaKeys`, `pingModel`, `pingText`, and `pingMaxTokens`.
- Produces: scheduler support for handler usage signature `getUsage(connection, proxyOptions): Promise<{quotas?: object}>`.

- [ ] **Step 1: Add Ollama mocks and config to the existing test harness**

Add the following mock beside the Claude/Codex usage mocks:

```js
vi.mock("open-sse/services/usage/misc.js", () => ({
  getOllamaUsage: vi.fn(),
}));
```

Add this provider to the mocked `QUOTA_AUTOPING_CONFIG.providers`:

```js
ollama: {
  settingsKey: "ollamaAutoPing",
  authType: "apikey",
  pingIntervalMs: 5 * 60 * 60 * 1000,
  requiredQuotaKeys: ["Session (5h)", "Weekly (7d)"],
  pingModel: "gemma4",
  pingText: "hi",
  pingMaxTokens: 1,
},
```

Import/reset `getOllamaUsage` in `beforeEach`. Keep the executor response body drainable:

```js
let getOllamaUsage;

({ getOllamaUsage } = await import("open-sse/services/usage/misc.js"));
```

- [ ] **Step 2: Write failing tests for interval, quota, request, and cooldown behavior**

Add focused tests with this shared eligible usage result:

```js
const ollamaUsageAvailable = {
  quotas: {
    "Session (5h)": { used: 20, total: 100, remainingPercentage: 80 },
    "Weekly (7d)": { used: 30, total: 100, remainingPercentage: 70 },
  },
};
```

Test the first successful ping and exact request:

```js
it("sends an initial minimal gemma4 ping for an opted-in Ollama API key", async () => {
  deps.getSettings.mockResolvedValue({ ollamaAutoPing: { connections: { "ollama-1": true } } });
  deps.getProviderConnections.mockResolvedValue([{
    id: "ollama-1", provider: "ollama", authType: "apikey", apiKey: "ollama-key",
  }]);
  getOllamaUsage.mockResolvedValue(ollamaUsageAvailable);

  await runQuotaAutoPingTick(deps, state);

  expect(getOllamaUsage).toHaveBeenCalledWith("ollama-key", undefined, expect.any(Object));
  expect(deps.getExecutor).toHaveBeenCalledWith("ollama");
  expect(deps.getExecutor.mock.results[0].value.execute).toHaveBeenCalledWith(expect.objectContaining({
    model: "gemma4",
    stream: false,
    credentials: expect.objectContaining({ apiKey: "ollama-key", connectionId: "ollama-1" }),
    body: {
      model: "gemma4",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      options: { num_predict: 1 },
    },
  }));
  expect(deps.updateProviderConnection).toHaveBeenCalledWith("ollama-1", expect.objectContaining({
    lastPingAt: "2026-01-01T12:00:00.000Z",
  }));
});
```

Add separate tests asserting:

```js
// lastPingAt = 4h59m ago => executor not called
// lastPingAt = 5h ago => executor called once
// Session (5h) remainingPercentage = 0 => executor not called
// Weekly (7d) remainingPercentage = 0 => executor not called
// either required quota missing => executor not called
// response.ok = false => updateProviderConnection not called and failureCache["ollama:ollama-1"] is set
// a second tick within failureCooldownMs => executor remains at one call
```

Use API-key connections in every Ollama case so the tests prove the scheduler does not retain its current OAuth-only filter.

- [ ] **Step 3: Run the Ollama tests and verify RED**

Run:

```bash
cd tests && npx vitest run unit/quota-auto-ping.test.js -t "Ollama|gemma4"
```

Expected: FAIL because there is no Ollama provider handler/config and the current target filter accepts only `authType === "oauth"`.

- [ ] **Step 4: Add minimal Ollama provider configuration**

Add to `QUOTA_AUTOPING_CONFIG.providers` in `src/shared/constants/config.js`:

```js
ollama: {
  settingsKey: "ollamaAutoPing",
  authType: "apikey",
  pingIntervalMs: 5 * 60 * 60 * 1000,
  requiredQuotaKeys: ["Session (5h)", "Weekly (7d)"],
  pingModel: "gemma4",
  pingText: "hi",
  pingMaxTokens: 1,
},
```

Also set `authType: "oauth"` on the existing Claude and Codex configs so eligibility is data-driven rather than special-cased.

- [ ] **Step 5: Adapt provider handlers to receive the connection**

Import Ollama usage:

```js
import { getOllamaUsage } from "open-sse/services/usage/misc.js";
```

Change handlers to wrappers and add Ollama:

```js
const providerHandlers = {
  claude: {
    getUsage: (connection, proxyOptions) => getClaudeUsage(connection.accessToken, proxyOptions),
    sendPing: sendClaudePing,
  },
  codex: {
    getUsage: (connection, proxyOptions) => getCodexUsage(connection.accessToken, proxyOptions),
    sendPing: sendCodexPing,
  },
  ollama: {
    getUsage: (connection, proxyOptions) => getOllamaUsage(
      connection.apiKey,
      connection.providerSpecificData,
      proxyOptions,
    ),
    sendPing: sendOllamaPing,
  },
};
```

Change the usage call in `pingConnection` to:

```js
const usage = await handler.getUsage(connection, proxyOptions);
```

- [ ] **Step 6: Implement the minimal Ollama sender**

Add beside `sendCodexPing`:

```js
async function sendOllamaPing(connection, providerConfig, proxyOptions, deps) {
  const executor = deps.getExecutor("ollama");
  const { response } = await executor.execute({
    model: providerConfig.pingModel,
    stream: false,
    credentials: {
      apiKey: connection.apiKey,
      connectionId: connection.id,
      providerSpecificData: connection.providerSpecificData,
    },
    proxyOptions,
    log: console,
    body: {
      model: providerConfig.pingModel,
      messages: [{ role: "user", content: providerConfig.pingText }],
      stream: false,
      options: { num_predict: providerConfig.pingMaxTokens },
    },
  });
  if (!response.ok) {
    try { await response.body?.cancel?.(); } catch { /* noop */ }
    return false;
  }
  await drainResponseBody(response);
  return true;
}
```

Do not add model fallback or catalog mutation.

- [ ] **Step 7: Implement interval eligibility and required quota checks**

Add a helper that understands the UI/usage contract directly:

```js
function hasAvailableRequiredQuotas(quotas, keys) {
  return keys.every((key) => {
    const quota = quotas?.[key];
    if (!quota) return false;
    const remaining = toFiniteNumber(quota.remainingPercentage);
    return remaining !== null ? remaining > 0 : !isQuotaExhausted(quota);
  });
}
```

In `pingConnection`, after usage is fetched and before reset-based logic, add the interval branch:

```js
if (providerConfig.pingIntervalMs) {
  if (!hasAvailableRequiredQuotas(quotas, providerConfig.requiredQuotaKeys || [])) return;
  if (wasPingedRecently(connection, providerConfig.pingIntervalMs)) return;

  const ok = await handler.sendPing(connection, providerConfig, proxyOptions, deps);
  if (!ok) {
    state.failureCache[key] = Date.now();
    console.warn(`[AutoPing] ${provider}:${connection.id}: ping failed`);
    return;
  }

  delete state.failureCache[key];
  const now = new Date().toISOString();
  await deps.updateProviderConnection(connection.id, { lastPingAt: now, updatedAt: now });
  console.log(`[AutoPing] ${provider}:${connection.id}: ping sent`);
  return;
}
```

Change target filtering in `runQuotaAutoPingTick` to:

```js
const targets = conns.filter((conn) =>
  conn.authType === providerConfig.authType && enabledMap[conn.id] === true
);
```

Keep all existing reset-based Claude/Codex behavior after this branch unchanged.

- [ ] **Step 8: Run the focused test and verify GREEN**

Run:

```bash
cd tests && npx vitest run unit/quota-auto-ping.test.js
```

Expected: all existing and new tests PASS with no warnings from unexpected scheduler work.

- [ ] **Step 9: Commit scheduler behavior**

```bash
git add tests/unit/quota-auto-ping.test.js src/shared/constants/config.js src/shared/services/quotaAutoPing.js
git commit -m "feat(ollama): add five-hour quota auto-ping

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Settings and UI Opt-In Wiring

**Files:**
- Modify: `tests/unit/quota-auto-ping.test.js:122-139`
- Modify: `src/shared/services/initializeApp.js:110-126`
- Modify: `src/app/api/settings/route.js:99-109`
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js:28-31,319-321,966-970`
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js:26-28`
- Modify: `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js:58-66,134,539-547,1159-1169`

**Interfaces:**
- Consumes: settings shape `{ ollamaAutoPing: { connections: Record<string, boolean> } }`.
- Produces: immediate `configureQuotaAutoPing(settings)` calls after Ollama setting patches.
- Produces: Ollama API-key auto-ping toggles on provider detail and Usage pages.

- [ ] **Step 1: Write failing scheduler lifecycle tests for Ollama-only opt-in**

Extend the existing fake-timer test:

```js
it("starts and stops the scheduler for an Ollama-only opt-in", () => {
  vi.useFakeTimers();

  configureQuotaAutoPing({ ollamaAutoPing: { connections: {} } });
  expect(vi.getTimerCount()).toBe(0);

  configureQuotaAutoPing({ ollamaAutoPing: { connections: { "ollama-1": true } } });
  expect(vi.getTimerCount()).toBe(1);

  configureQuotaAutoPing({ ollamaAutoPing: { connections: { "ollama-1": false } } });
  expect(vi.getTimerCount()).toBe(0);
});
```

- [ ] **Step 2: Run the lifecycle test and verify RED if config wiring is incomplete**

Run:

```bash
cd tests && npx vitest run unit/quota-auto-ping.test.js -t "Ollama-only"
```

Expected before all wiring is present: FAIL if the scheduler does not inspect Ollama settings. If Task 1's declarative provider loop already makes this pass, retain it as regression coverage and continue; the production startup/API/UI wiring is still missing.

- [ ] **Step 3: Wire startup and settings PATCH handling**

Change `hasQuotaAutoPingEnabled` in `initializeApp.js`:

```js
return [settings?.claudeAutoPing, settings?.codexAutoPing, settings?.ollamaAutoPing]
  .some((config) => Object.values(config?.connections || {}).some(Boolean));
```

Add this condition in `src/app/api/settings/route.js`:

```js
Object.prototype.hasOwnProperty.call(body, "ollamaAutoPing")
```

Keep dynamic import behavior unchanged.

- [ ] **Step 4: Expose Ollama toggle on provider detail**

Add the setting map entry:

```js
ollama: "ollamaAutoPing",
```

Replace the OAuth-only render condition with the exact supported auth check:

```js
const supportsAutoPingConnection = AUTO_PING_SETTINGS_KEYS[providerId]
  && (conn.authType === "oauth" || (providerId === "ollama" && conn.authType === "apikey"));
```

Use `supportsAutoPingConnection` for the `autoPing` prop. Update `ConnectionRow` tooltip selection:

```js
const autoPingTooltip = autoPing?.provider === "ollama"
  ? "Sends a tiny gemma4 request every 5h while session and weekly quota remain. Consumes a small amount of quota."
  : autoPing?.provider === "codex"
    ? "Auto-starts the next 5h Codex window after reset by sending a tiny gpt-5.5 request. Consumes a small amount of quota."
    : "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.";
```

- [ ] **Step 5: Expose Ollama toggle on Usage**

Add:

```js
ollama: "ollamaAutoPing",
```

to `AUTO_PING_SETTINGS_KEYS`, add tooltip text matching the provider page, initialize state with an Ollama map:

```js
const [autoPingMaps, setAutoPingMaps] = useState({ claude: {}, codex: {}, ollama: {} });
```

Load persisted settings:

```js
ollama: s?.ollamaAutoPing?.connections || {},
```

Replace the OAuth-only render condition with:

```jsx
{AUTO_PING_SETTINGS_KEYS[conn.provider]
  && (conn.authType === "oauth" || (conn.provider === "ollama" && conn.authType === "apikey")) && (
  // existing Tooltip/button unchanged
)}
```

- [ ] **Step 6: Run focused tests and lint changed UI/server files**

Run:

```bash
cd tests && npx vitest run unit/quota-auto-ping.test.js
cd .. && npx eslint \
  src/shared/constants/config.js \
  src/shared/services/quotaAutoPing.js \
  src/shared/services/initializeApp.js \
  src/app/api/settings/route.js \
  'src/app/(dashboard)/dashboard/providers/[id]/page.js' \
  'src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js' \
  'src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js' \
  tests/unit/quota-auto-ping.test.js
```

Expected: test file PASS; ESLint reports no new errors in changed files.

- [ ] **Step 7: Commit settings and UI wiring**

```bash
git add \
  tests/unit/quota-auto-ping.test.js \
  src/shared/services/initializeApp.js \
  src/app/api/settings/route.js \
  'src/app/(dashboard)/dashboard/providers/[id]/page.js' \
  'src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js' \
  'src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js'
git commit -m "feat(ui): enable Ollama Cloud auto-ping opt-in

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Final Regression Verification

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Confirms all interfaces introduced by Tasks 1-2 and preserves existing xAI/tool-call behavior on the release branch.

- [ ] **Step 1: Run focused auto-ping tests**

```bash
cd tests && npx vitest run unit/quota-auto-ping.test.js
```

Expected: all Claude, Codex, and Ollama auto-ping tests PASS.

- [ ] **Step 2: Run fork-specific regression tests**

```bash
cd tests && npx vitest run \
  unit/xai-usage.test.js \
  unit/xai-usage-route.test.js \
  unit/codex-optional-tool-args.test.js
```

Expected: 28 tests PASS, preserving xAI OAuth usage and optional tool-call arguments.

- [ ] **Step 3: Run diff and repository checks**

```bash
git diff v0.5.50..HEAD --check
git status --short --branch
git log --oneline --decorate -5
```

Expected: no whitespace errors; working tree clean; Ollama implementation commits are on `merge/v0.5.50-xai-oauth-usage` after the approved spec commit.

- [ ] **Step 4: Do not push without explicit confirmation**

Report the test evidence and local commit hashes. Ask before pushing the updated branch/tag because push is outward-facing and the existing `v0.5.50-xai-oauth-usage` tag already points to the pre-feature commit.
