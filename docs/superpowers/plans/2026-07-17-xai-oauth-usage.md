# xAI OAuth Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Grok billing quotas for xAI OAuth connections while leaving xAI API-key and existing `grok-cli` behavior unchanged.

**Architecture:** Extend the existing Grok billing parser with an optional second billing payload and xAI-only formatting options, then expose a dedicated `getXaiUsage` wrapper that reads xAI's registry URLs. Keep billing endpoints independent so either successful response can produce quota, and add xAI refresh to `DefaultExecutor` through the existing proxy-aware form refresh helper.

**Tech Stack:** JavaScript ESM, Vitest, native `fetch`/`Response`, existing `proxyAwareFetch`, provider registry.

## Global Constraints

- Implement usage only when `provider === "xai"` and `authType === "oauth"`.
- Do not add dependencies.
- Do not change models, chat dispatch, the Grok CLI executor, dashboard quota UI, or database schema.
- Preserve existing `grok-cli` labels and responses for its current payloads.
- xAI API-key connections must remain unsupported by the Usage API.
- All billing and refresh network calls must receive the connection's `proxyOptions`.
- A successful billing endpoint must remain usable when another billing or user endpoint fails.
- Do not infer exhaustion or active subscription from absent/unknown data.

## File Structure

- Modify `open-sse/services/usage/grok-cli.js`: shared billing normalization, independent endpoint fetches, `getXaiUsage` wrapper.
- Modify `open-sse/services/usage.js`: register the dedicated xAI usage handler.
- Modify `open-sse/providers/registry/xai.js`: declare usage capability and endpoint URLs.
- Modify `open-sse/executors/default.js`: proxy-aware xAI OAuth refresh.
- Modify `tests/unit/grok-cli-usage.test.js`: preserve Grok CLI behavior and cover shared parser extensions.
- Create `tests/unit/xai-usage.test.js`: xAI registry, fetch, partial-failure, and refresh coverage.
- Create `tests/unit/xai-usage-route.test.js`: OAuth retry and API-key rejection at the application boundary.

---

### Task 1: Extend the shared Grok billing parser without changing Grok CLI defaults

**Files:**
- Modify: `open-sse/services/usage/grok-cli.js:37-257`
- Modify: `tests/unit/grok-cli-usage.test.js:21-133`

**Interfaces:**
- Consumes: existing `parseResetTime(value)`, `toFiniteNumber(value, fallback)`, and `makeQuota({used,total,resetAt})` behavior.
- Produces: `parseGrokCliBilling(billing, user = null, monthlyBilling = null, options = {})`, where `options.monthlyLabel` defaults to `"Monthly included"` and `options.includePercent` defaults to `false`.
- Returns: `{plan, quotas, periodEnd, exhausted, subscriptionAccess, rawConfig}` with existing Grok CLI defaults preserved.

- [ ] **Step 1: Add failing parser fixtures and tests**

Add these fixtures after `ACTIVE_BILLING` in `tests/unit/grok-cli-usage.test.js`:

```javascript
const PERCENT_BILLING = {
  config: {
    currentPeriod: { end: "2026-07-22T00:00:00Z" },
    productUsage: [{ product: "Api", usagePercent: 34 }],
    creditUsagePercent: 34,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
  },
};

const MONTHLY_BILLING = {
  config: {
    monthlyLimit: { val: 15000 },
    used: { val: 874 },
    billingPeriodEnd: "2026-08-01T00:00:00Z",
  },
};
```

Add these tests inside `describe("parseGrokCliBilling", ...)`:

```javascript
it("merges xAI percent and monthly payloads when explicitly enabled", () => {
  const parsed = parseGrokCliBilling(
    PERCENT_BILLING,
    { subscriptionTier: "XPremiumPlus", hasGrokCodeAccess: true },
    MONTHLY_BILLING,
    { includePercent: true, monthlyLabel: "Monthly" },
  );

  expect(parsed.quotas.Weekly).toMatchObject({
    used: 34,
    total: 100,
    remainingPercentage: 66,
    resetAt: "2026-07-22T00:00:00.000Z",
  });
  expect(parsed.quotas.Monthly).toMatchObject({
    used: 874,
    total: 15000,
    resetAt: "2026-08-01T00:00:00.000Z",
  });
  expect(parsed.quotas["Monthly included"]).toBeUndefined();
  expect(parsed.exhausted).toBe(false);
});

it("preserves legacy monthly usage fields from either payload", () => {
  const parsed = parseGrokCliBilling(
    { config: {} },
    null,
    {
      config: {
        monthly_limit: { val: 1000 },
        included_used: { val: 275 },
      },
    },
    { monthlyLabel: "Monthly" },
  );

  expect(parsed.quotas.Monthly).toMatchObject({
    used: 275,
    total: 1000,
    remainingPercentage: 72.5,
  });
});

it.each(["expired", "cancelled", "inactive", "unknown-tier"])(
  "does not treat %s as proof of active subscription",
  (subscriptionTier) => {
    const parsed = parseGrokCliBilling(EXHAUSTED_BILLING, { subscriptionTier });
    expect(parsed.subscriptionAccess).toBe(false);
  },
);

it("keeps the existing Grok CLI monthly label by default", () => {
  const parsed = parseGrokCliBilling({
    monthlyLimit: { val: 1000 },
    includedUsed: { val: 250 },
  });
  expect(parsed.quotas["Monthly included"]).toMatchObject({ used: 250, total: 1000 });
  expect(parsed.quotas.Monthly).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused parser tests and confirm failure**

Run:

```bash
cd /Users/bacnv/GolandProjects/bacnv-9router/9router/tests
npx vitest run unit/grok-cli-usage.test.js
```

Expected: FAIL because the third and fourth `parseGrokCliBilling` arguments are ignored, `Weekly`/`Monthly` are missing, and unknown tiers currently set `subscriptionAccess: true`.

- [ ] **Step 3: Add payload normalization and conservative subscription-state helpers**

In `open-sse/services/usage/grok-cli.js`, add after `unwrapVal`:

```javascript
function billingConfig(billing) {
  const root = billing && typeof billing === "object" ? billing : {};
  const config =
    root.config && typeof root.config === "object" && !Array.isArray(root.config)
      ? root.config
      : root;
  return { root, config };
}

const ACTIVE_SUBSCRIPTION_TIERS = new Set([
  "grokpro",
  "supergrok",
  "premium",
  "premiumplus",
  "xpremium",
  "xpremiumplus",
]);

function hasActiveSubscription(user, config) {
  const normalized = subscriptionTier(user, config)
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  return ACTIVE_SUBSCRIPTION_TIERS.has(normalized);
}
```

This is deliberately an allowlist: unknown, expired, cancelled, and inactive strings are not positive access signals.

- [ ] **Step 4: Replace the parser setup and period selection**

Change the parser signature and opening block to:

```javascript
export function parseGrokCliBilling(
  billing,
  user = null,
  monthlyBilling = null,
  { monthlyLabel = "Monthly included", includePercent = false } = {},
) {
  const { root, config } = billingConfig(billing);
  const { root: monthlyRoot, config: monthlyConfig } = billingConfig(monthlyBilling);

  const periodEnd =
    parseResetTime(config.billingPeriodEnd) ||
    parseResetTime(config.billing_period_end) ||
    parseResetTime(config.currentPeriod?.end) ||
    parseResetTime(config.resetAt || config.resetsAt || config.periodEnd) ||
    parseResetTime(root.billingPeriodEnd) ||
    parseResetTime(root.billing_period_end) ||
    parseResetTime(root.resetAt || root.resetsAt || root.periodEnd) ||
    null;
  const monthlyPeriodEnd =
    parseResetTime(monthlyConfig.billingPeriodEnd) ||
    parseResetTime(monthlyConfig.billing_period_end) ||
    parseResetTime(monthlyRoot.billingPeriodEnd) ||
    parseResetTime(monthlyRoot.billing_period_end) ||
    periodEnd;

  const quotas = {};
  const subscriptionAccess = hasActiveSubscription(user, config) ||
    hasActiveSubscription(user, monthlyConfig);
```

- [ ] **Step 5: Add opt-in percent quota parsing**

Insert before monthly parsing:

```javascript
  if (includePercent) {
    const productUsage = Array.isArray(config.productUsage)
      ? config.productUsage
      : Array.isArray(root.productUsage)
        ? root.productUsage
        : [];
    let hasPercent = false;

    for (const item of productUsage) {
      if (!item || typeof item !== "object") continue;
      const percent = unwrapVal(item.usagePercent, NaN);
      if (!Number.isFinite(percent)) continue;
      const used = Math.min(100, Math.max(0, percent));
      const rawProduct = String(item.product || "").trim();
      const label = /^api$/i.test(rawProduct)
        ? "Weekly"
        : rawProduct
          .replace(/[_-]+/g, " ")
          .replace(/([a-z\d])([A-Z])/g, "$1 $2")
          .replace(/\b\w/g, (char) => char.toUpperCase()) || "Usage";
      if (quotas[label]) continue;
      quotas[label] = makeQuota({ used, total: 100, resetAt: periodEnd });
      hasPercent = true;
    }

    const aggregatePercent = unwrapVal(
      config.creditUsagePercent ?? root.creditUsagePercent,
      NaN,
    );
    if (!hasPercent && Number.isFinite(aggregatePercent)) {
      quotas.Weekly = makeQuota({
        used: Math.min(100, Math.max(0, aggregatePercent)),
        total: 100,
        resetAt: periodEnd,
      });
    }
  }
```

- [ ] **Step 6: Replace monthly field selection while retaining all legacy names**

Replace the current monthly block with:

```javascript
  const monthlyLimit = unwrapVal(
    monthlyConfig.monthlyLimit ??
      monthlyConfig.monthly_limit ??
      monthlyRoot.monthlyLimit ??
      monthlyRoot.monthly_limit ??
      config.monthlyLimit ??
      config.monthly_limit ??
      root.monthlyLimit ??
      root.monthly_limit,
    NaN,
  );
  const monthlyUsed = unwrapVal(
    monthlyConfig.used ??
      monthlyRoot.used ??
      monthlyConfig.includedUsed ??
      monthlyConfig.included_used ??
      monthlyRoot.includedUsed ??
      monthlyRoot.included_used ??
      monthlyConfig.totalUsed ??
      monthlyConfig.total_used ??
      monthlyRoot.totalUsed ??
      monthlyRoot.total_used ??
      config.used ??
      root.used ??
      config.includedUsed ??
      config.included_used ??
      root.includedUsed ??
      root.included_used ??
      config.totalUsed ??
      config.total_used ??
      root.totalUsed ??
      root.total_used,
    NaN,
  );
  if (Number.isFinite(monthlyLimit) && monthlyLimit > 0) {
    quotas[monthlyLabel] = makeQuota({
      used: Number.isFinite(monthlyUsed) ? monthlyUsed : 0,
      total: monthlyLimit,
      resetAt: monthlyPeriodEnd,
    });
  }
```

At return time, use the first config that has plan information without selecting a merely non-empty config:

```javascript
  const planConfig = subscriptionTier(null, config) || config.isUnifiedBillingUser === true
    ? config
    : monthlyConfig;

  return {
    plan: resolvePlan(user, planConfig),
    quotas,
    periodEnd: monthlyPeriodEnd || periodEnd,
    exhausted,
    subscriptionAccess,
    rawConfig: planConfig,
  };
```

Keep the existing on-demand, prepaid, richer credit-envelope, and `exhausted` blocks otherwise unchanged.

- [ ] **Step 7: Run parser tests and confirm they pass**

Run:

```bash
cd /Users/bacnv/GolandProjects/bacnv-9router/9router/tests
npx vitest run unit/grok-cli-usage.test.js
```

Expected: PASS, including the pre-existing `Monthly included`, on-demand, prepaid, and plan assertions.

- [ ] **Step 8: Commit the parser change**

```bash
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router add open-sse/services/usage/grok-cli.js tests/unit/grok-cli-usage.test.js
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router commit -m "feat(xai): normalize Grok billing quotas"
```

---

### Task 2: Add the dedicated xAI usage handler with independent endpoint failures

**Files:**
- Modify: `open-sse/providers/registry/xai.js:21-28`
- Modify: `open-sse/services/usage/grok-cli.js:259-328`
- Modify: `open-sse/services/usage.js:14,47-48`
- Create: `tests/unit/xai-usage.test.js`

**Interfaces:**
- Consumes: `parseGrokCliBilling(billing, user, monthlyBilling, options)` from Task 1 and `PROVIDERS[provider].usage` registry transport data.
- Produces: `getXaiUsage(accessToken, providerSpecificData = null, proxyOptions = null)` returning the same normalized `{plan, quotas}` or `{message, quotas?}` shape as other usage handlers.
- Internal helper: `getGrokUsage({ provider, accessToken, providerSpecificData, proxyOptions, includeMonthly, includePercent, monthlyLabel })`.

- [ ] **Step 1: Create failing xAI registry and usage tests**

Create `tests/unit/xai-usage.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CREDITS = {
  config: {
    currentPeriod: { end: "2026-07-22T00:00:00Z" },
    productUsage: [{ product: "Api", usagePercent: 34 }],
  },
};

const MONTHLY = {
  config: {
    monthlyLimit: { val: 15000 },
    used: { val: 874 },
    billingPeriodEnd: "2026-08-01T00:00:00Z",
  },
};

const USER = {
  userId: "user-1",
  email: "user@example.com",
  hasGrokCodeAccess: true,
  subscriptionTier: "XPremiumPlus",
};

describe("xai OAuth usage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is exposed by the registry with all billing URLs", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("xai");
    expect(PROVIDERS.xai.usage).toMatchObject({
      url: expect.stringContaining("format=credits"),
      monthlyUrl: expect.stringMatching(/\/v1\/billing$/),
      userUrl: expect.stringContaining("include=subscription"),
    });
  });

  it("returns combined weekly and monthly quotas", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(CREDITS))
      .mockResolvedValueOnce(jsonResponse(MONTHLY))
      .mockResolvedValueOnce(jsonResponse(USER));

    const proxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local",
      strictProxy: false,
    };
    const usage = await getUsageForProvider({
      provider: "xai",
      accessToken: "xai-token",
      providerSpecificData: { userId: "user-1", email: "user@example.com" },
    }, proxyOptions);

    expect(usage.quotas.Weekly).toMatchObject({ used: 34, total: 100 });
    expect(usage.quotas.Monthly).toMatchObject({ used: 874, total: 15000 });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    for (const call of proxyAwareFetch.mock.calls) {
      expect(call[1].headers.Authorization).toBe("Bearer xai-token");
      expect(call[2]).toBe(proxyOptions);
    }
  });

  it("uses monthly quota when credits fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(MONTHLY))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.message).toBeUndefined();
    expect(usage.quotas.Monthly).toMatchObject({ used: 874, total: 15000 });
  });

  it("uses weekly quota when monthly fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(CREDITS))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockRejectedValueOnce(new Error("user endpoint down"));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.message).toBeUndefined();
    expect(usage.quotas.Weekly).toMatchObject({ used: 34, total: 100 });
  });

  it("returns auth-expired only when no billing endpoint succeeds", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "expired" });
    expect(usage.message).toMatch(/expired|re-authorize/i);
  });

  it("returns a billing error when both billing endpoints fail without auth errors", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "bad gateway" }, 502))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.message).toMatch(/billing API error.*502.*503/i);
  });
});
```

- [ ] **Step 2: Run the xAI test and confirm failure**

Run:

```bash
cd /Users/bacnv/GolandProjects/bacnv-9router/9router/tests
npx vitest run unit/xai-usage.test.js
```

Expected: FAIL because xAI lacks `features.usage`, registry usage URLs, and a usage handler.

- [ ] **Step 3: Declare xAI usage URLs and capability**

In `open-sse/providers/registry/xai.js`, add this under `transport`:

```javascript
    usage: {
      url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      monthlyUrl: "https://cli-chat-proxy.grok.com/v1/billing",
      userUrl: "https://cli-chat-proxy.grok.com/v1/user?include=subscription",
    },
```

Add this before `models`:

```javascript
  features: { usage: true },
```

Do not add `usageApikey`; its absence is what keeps API-key connections ineligible.

- [ ] **Step 4: Replace the single-purpose fetch function with a shared internal helper**

In `open-sse/services/usage/grok-cli.js`, retain the existing Grok CLI constants and replace `getGrokCliUsage` with the following structure:

```javascript
async function readJson(response) {
  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  return body && typeof body === "object" ? body : null;
}

async function getGrokUsage({
  provider,
  accessToken,
  providerSpecificData,
  proxyOptions,
  includeMonthly,
  includePercent,
  monthlyLabel,
}) {
  const usage = U(provider);
  const creditsUrl = usage.url;
  const monthlyUrl = usage.monthlyUrl;
  const userUrl = usage.userUrl;
  const providerName = provider === "xai" ? "xAI" : "Grok CLI";

  if (!accessToken) return { message: `${providerName} access token not available.` };

  const headers = buildGrokCliHeaders(accessToken, providerSpecificData);
  try {
    const [creditsResult, monthlyResult, userResult] = await Promise.allSettled([
      proxyAwareFetch(creditsUrl, { method: "GET", headers }, proxyOptions),
      includeMonthly && monthlyUrl
        ? proxyAwareFetch(monthlyUrl, { method: "GET", headers }, proxyOptions)
        : Promise.resolve(null),
      userUrl
        ? proxyAwareFetch(userUrl, { method: "GET", headers }, proxyOptions)
        : Promise.resolve(null),
    ]);

    const creditsResponse = creditsResult.status === "fulfilled" ? creditsResult.value : null;
    const monthlyResponse = monthlyResult.status === "fulfilled" ? monthlyResult.value : null;
    const userResponse = userResult.status === "fulfilled" ? userResult.value : null;
    const billingResponses = [creditsResponse, monthlyResponse].filter(Boolean);
    const successfulBilling = billingResponses.filter((response) => response.ok);

    if (successfulBilling.length === 0) {
      if (billingResponses.some((response) => response.status === 401 || response.status === 403)) {
        return { message: `${providerName} authentication expired. Please re-authorize.` };
      }
      const statuses = billingResponses.map((response) => response.status).join(", ") || "network";
      return { message: `${providerName} billing API error (${statuses})` };
    }

    const credits = await readJson(creditsResponse);
    const monthly = await readJson(monthlyResponse);
    const user = await readJson(userResponse);
    const parsed = parseGrokCliBilling(
      credits,
      user,
      monthly,
      { includePercent, monthlyLabel },
    );

    if (Object.keys(parsed.quotas).length === 0) {
      return {
        plan: parsed.plan,
        message: parsed.subscriptionAccess
          ? "Subscription access is active; Grok does not expose a numeric included quota."
          : `${providerName} connected, but no credit allotment was returned.`,
        quotas: {},
      };
    }

    return { plan: parsed.plan, quotas: parsed.quotas };
  } catch (error) {
    return { message: `${providerName} usage error: ${error.message}` };
  }
}

export function getGrokCliUsage(accessToken, providerSpecificData = null, proxyOptions = null) {
  return getGrokUsage({
    provider: "grok-cli",
    accessToken,
    providerSpecificData,
    proxyOptions,
    includeMonthly: false,
    includePercent: false,
    monthlyLabel: "Monthly included",
  });
}

export function getXaiUsage(accessToken, providerSpecificData = null, proxyOptions = null) {
  return getGrokUsage({
    provider: "xai",
    accessToken,
    providerSpecificData,
    proxyOptions,
    includeMonthly: true,
    includePercent: true,
    monthlyLabel: "Monthly",
  });
}
```

Important: `getGrokCliUsage` keeps `includeMonthly: false`, so it still makes two requests and all pre-existing mocks and output labels remain valid.

- [ ] **Step 5: Register the dedicated handler**

In `open-sse/services/usage.js`, change the import to:

```javascript
import { getGrokCliUsage, getXaiUsage } from "./usage/grok-cli.js";
```

Add to `USAGE_HANDLERS`:

```javascript
  xai: (c) => getXaiUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
```

- [ ] **Step 6: Run xAI and Grok CLI tests**

Run:

```bash
cd /Users/bacnv/GolandProjects/bacnv-9router/9router/tests
npx vitest run unit/xai-usage.test.js unit/grok-cli-usage.test.js
```

Expected: PASS. The Grok CLI tests must still observe exactly two fetches per call and the `Monthly included` default label.

- [ ] **Step 7: Commit the usage handler**

```bash
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router add open-sse/providers/registry/xai.js open-sse/services/usage.js open-sse/services/usage/grok-cli.js tests/unit/xai-usage.test.js
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router commit -m "feat(xai): expose OAuth usage quotas"
```

---

### Task 3: Refresh xAI OAuth credentials through the connection proxy

**Files:**
- Modify: `open-sse/executors/default.js:218-245`
- Modify: `tests/unit/xai-usage.test.js`

**Interfaces:**
- Consumes: `DefaultExecutor.refreshWithForm(url, params, proxyOptions)` and flattened `PROVIDERS.xai.{refreshUrl,clientId}`.
- Produces: `new DefaultExecutor("xai").refreshCredentials(credentials, log, proxyOptions)` returning `{accessToken, refreshToken, expiresIn}`.

- [ ] **Step 1: Add a failing proxy-aware refresh test**

Append to `tests/unit/xai-usage.test.js`:

```javascript
describe("xai OAuth refresh", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refreshes through proxyAwareFetch and preserves an unrotated refresh token", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      access_token: "new-access-token",
      expires_in: 3600,
    }));
    const proxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local",
      strictProxy: false,
    };

    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const result = await new DefaultExecutor("xai").refreshCredentials(
      { refreshToken: "old-refresh-token" },
      null,
      proxyOptions,
    );

    expect(result).toEqual({
      accessToken: "new-access-token",
      refreshToken: "old-refresh-token",
      expiresIn: 3600,
    });
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://auth.x.ai/oauth2/token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(URLSearchParams),
      }),
      proxyOptions,
    );
    const body = proxyAwareFetch.mock.calls[0][1].body;
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh-token",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    });
  });
});
```

- [ ] **Step 2: Run the refresh test and confirm failure**

Run:

```bash
cd /Users/bacnv/GolandProjects/bacnv-9router/9router/tests
npx vitest run unit/xai-usage.test.js -t "refreshes through proxyAwareFetch"
```

Expected: FAIL because `DefaultExecutor` has no xAI refresher and returns `null`.

- [ ] **Step 3: Add the minimal xAI refresher**

In the `refreshers` map in `open-sse/executors/default.js`, add:

```javascript
      xai: () => this.refreshWithForm(PROVIDERS.xai.refreshUrl, {
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: PROVIDERS.xai.clientId,
      }, proxyOptions),
```

Do not call `refreshProviderCredentials` here: that implementation reaches xAI's service through unproxied global `fetch`, which violates the connection proxy requirement.

- [ ] **Step 4: Run the refresh and usage tests**

Run:

```bash
cd /Users/bacnv/GolandProjects/bacnv-9router/9router/tests
npx vitest run unit/xai-usage.test.js unit/grok-cli-usage.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit proxy-aware refresh**

```bash
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router add open-sse/executors/default.js tests/unit/xai-usage.test.js
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router commit -m "fix(xai): refresh OAuth token through proxy"
```

---

### Task 4: Verify the application boundary rejects API keys and retries expired OAuth

**Files:**
- Create: `tests/unit/xai-usage-route.test.js`
- Modify only if the tests expose a mismatch: `src/app/api/usage/[connectionId]/route.js:122-185`

**Interfaces:**
- Consumes: existing `GET(request, {params})` and `refreshAndUpdateCredentials(connection, force, proxyOptions)`.
- Produces: observable route guarantees: API-key xAI returns the existing unavailable message without billing calls; OAuth auth-expired result causes exactly one forced refresh and one retry.

- [ ] **Step 1: Create route-level tests**

Create `tests/unit/xai-usage-route.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getUsageForProvider: vi.fn(),
  getExecutor: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: mocks.getExecutor,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

describe("xAI usage route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local",
    });
  });

  it("rejects xAI API-key usage before resolving proxy or calling billing", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "xai-key",
      provider: "xai",
      authType: "apikey",
      apiKey: "secret",
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/xai-key"), {
      params: Promise.resolve({ connectionId: "xai-key" }),
    });

    expect(await response.json()).toEqual({
      message: "Usage not available for this connection",
    });
    expect(mocks.resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
  });

  it("force-refreshes xAI OAuth once and retries usage with the new token", async () => {
    const connection = {
      id: "xai-oauth",
      provider: "xai",
      authType: "oauth",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      providerSpecificData: {},
    };
    const refreshedConnection = { ...connection, accessToken: "new-token" };
    const executor = {
      needsRefresh: vi.fn().mockReturnValue(false),
      refreshCredentials: vi.fn().mockResolvedValue({
        accessToken: "new-token",
        refreshToken: "refresh-token",
        expiresIn: 3600,
      }),
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.getExecutor.mockReturnValue(executor);
    mocks.getUsageForProvider
      .mockResolvedValueOnce({ message: "xAI authentication expired. Please re-authorize." })
      .mockResolvedValueOnce({
        plan: "XPremiumPlus",
        quotas: { Weekly: { used: 34, total: 100, remainingPercentage: 66 } },
      });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/xai-oauth"), {
      params: Promise.resolve({ connectionId: "xai-oauth" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).quotas.Weekly.used).toBe(34);
    expect(executor.refreshCredentials).toHaveBeenCalledTimes(1);
    expect(executor.refreshCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "refresh-token" }),
      console,
      expect.objectContaining({
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.local",
        strictProxy: false,
      }),
    );
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "xai-oauth",
      expect.objectContaining({ accessToken: "new-token" }),
    );
    expect(mocks.getUsageForProvider).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining(refreshedConnection),
      expect.objectContaining({ strictProxy: false }),
    );
  });
});
```

- [ ] **Step 2: Run route tests**

Run:

```bash
cd /Users/bacnv/GolandProjects/bacnv-9router/9router/tests
npx vitest run unit/xai-usage-route.test.js
```

Expected: PASS against the existing route. If it fails, change only the smallest route condition needed to satisfy these two boundary guarantees; do not add xAI to `USAGE_APIKEY_PROVIDERS`.

- [ ] **Step 3: Run the complete focused set**

Run:

```bash
cd /Users/bacnv/GolandProjects/bacnv-9router/9router/tests
npx vitest run unit/grok-cli-usage.test.js unit/xai-usage.test.js unit/xai-usage-route.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit route guarantees**

```bash
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router add tests/unit/xai-usage-route.test.js src/app/api/usage/'[connectionId]'/route.js
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router commit -m "test(xai): cover OAuth usage route"
```

If the route required no source change, omit it from `git add`.

---

### Task 5: Run regressions and verify the final diff

**Files:**
- Verify only: all files changed in Tasks 1-4.

**Interfaces:**
- Consumes: completed implementation and test suite.
- Produces: evidence that provider flattening, aliases, OAuth URLs, Grok CLI usage, and xAI usage remain correct.

- [ ] **Step 1: Run all focused unit tests**

```bash
cd /Users/bacnv/GolandProjects/bacnv-9router/9router/tests
npx vitest run unit/grok-cli-usage.test.js unit/xai-usage.test.js unit/xai-usage-route.test.js
```

Expected: PASS with no skipped xAI tests.

- [ ] **Step 2: Run provider and OAuth baselines from the repository root**

```bash
cd /Users/bacnv/GolandProjects/bacnv-9router/9router
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
node tests/__baseline__/verify-oauth-urls.mjs
```

Expected:

```text
✅ PROVIDERS byte-for-byte equal (... providers).
✅ Alias resolution byte-for-byte equal (... tokens).
✅ OAuth URLs byte-for-byte equal.
```

`features.usage` is registry metadata and `transport.usage` is intentionally excluded by `verify-providers.mjs`, so no baseline snapshot should be rewritten.

- [ ] **Step 3: Inspect the final diff for forbidden scope changes**

Run:

```bash
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router diff HEAD~4 -- open-sse tests/unit src/app/api/usage
```

Confirm all of the following:

- No model lists or chat endpoints changed.
- No `grok-cli` executor changes exist.
- No UI or database files changed.
- `xai` has `features.usage` but not `features.usageApikey`.
- Every xAI billing and refresh call passes `proxyOptions` to `proxyAwareFetch`.
- `getGrokCliUsage` still uses two calls and the old `Monthly included` label.

- [ ] **Step 4: Run the project verification skill before final completion**

Invoke `/verify` and exercise the xAI OAuth usage flow end-to-end if valid test credentials are available. If credentials are unavailable, record that live provider verification was skipped and retain the passing mocked route/fetch tests as the runnable check; do not claim live verification.

- [ ] **Step 5: Commit any verification-only corrections**

Only if Step 2-4 required source/test corrections:

```bash
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router add open-sse src/app/api/usage tests/unit
git -C /Users/bacnv/GolandProjects/bacnv-9router/9router commit -m "fix(xai): address usage verification findings"
```

If no corrections were needed, do not create an empty commit.
