/**
 * Grok CLI / Grok Build usage handler
 *
 * Source of truth: official grok-shell/grok-pager traffic to cli-chat-proxy.grok.com
 *   GET /v1/billing?format=credits
 *   GET /v1/user?include=subscription
 *
 * Observed billing shape (protobuf-json style `{ val: number }`):
 * {
 *   config: {
 *     currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
 *     onDemandCap: { val },
 *     onDemandUsed: { val },
 *     prepaidBalance: { val },
 *     isUnifiedBillingUser: true,
 *     billingPeriodStart, billingPeriodEnd
 *   }
 * }
 *
 * Exhausted free/promo accounts return cap=0/used=0/prepaid=0 and chat 402s with
 * personal-team-blocked:spending-limit. Paid/sub accounts surface non-zero cap
 * or prepaidBalance; richer credit fields are parsed opportunistically if present.
 */

import { U, fetchWithTimeout, parseResetTime, toFiniteNumber } from "./shared.js";
import {
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_USER_AGENT,
  GROK_CLI_VERSION,
} from "../../config/grokCli.js";

/** Unwrap protobuf-json `{ val: n }` or plain numbers/strings. */
function unwrapVal(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "object" && !Array.isArray(value) && "val" in value) {
    return toFiniteNumber(value.val, fallback);
  }
  return toFiniteNumber(value, fallback);
}

function billingConfig(billing) {
  const root = billing && typeof billing === "object" && !Array.isArray(billing) ? billing : {};
  const config =
    root.config && typeof root.config === "object" && !Array.isArray(root.config)
      ? root.config
      : root;
  return { root, config };
}

function hasUsableBilling(billing) {
  if (!billing || typeof billing !== "object" || Array.isArray(billing)) return false;
  const { root, config } = billingConfig(billing);
  return Object.keys(root).some((key) => key !== "config") || Object.keys(config).length > 0;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = unwrapVal(value, NaN);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
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

function buildGrokCliHeaders(accessToken, providerSpecificData = {}) {
  const psd = providerSpecificData || {};
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": GROK_CLI_USER_AGENT,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-grok-client-mode": "headless",
  };
  const email = psd.email;
  const userId = psd.userId || psd.principalId;
  if (email) headers["x-email"] = email;
  if (userId) headers["x-userid"] = userId;
  return headers;
}

function subscriptionTier(user, config) {
  const rawTier =
    user?.subscriptionTier ??
    user?.subscription_tier ??
    user?.subscription?.tier ??
    config?.subscriptionTier ??
    config?.subscription_tier;
  return typeof rawTier === "string" ? rawTier.trim() : "";
}

function resolvePlan(user, config) {
  const tier = subscriptionTier(user, config);
  if (tier) {
    return tier
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (user?.hasGrokCodeAccess === true) return "Grok Code";
  if (config?.isUnifiedBillingUser === true) return "Grok Build";
  return "Grok Build";
}

function makeQuota({ used, total, resetAt, unlimited = false }) {
  const safeTotal = Math.max(0, toFiniteNumber(total, 0));
  const safeUsed = Math.max(0, toFiniteNumber(used, 0));
  // Do NOT set absolute `remaining` — QuotaTable's getRemainingPercentage treats
  // `remaining` as a 0–100 percentage (same trap as Qoder credits).
  if (unlimited || safeTotal === 0) {
    return {
      used: safeUsed,
      total: 0,
      remainingPercentage: unlimited ? 100 : 0,
      resetAt: resetAt || null,
      unlimited: true,
    };
  }
  const remaining = Math.max(0, safeTotal - safeUsed);
  const remainingPercentage = (remaining / safeTotal) * 100;
  return {
    used: safeUsed,
    total: safeTotal,
    remainingPercentage,
    resetAt: resetAt || null,
    unlimited: false,
  };
}

/**
 * Map billing JSON → normalized quotas object for the dashboard.
 * Returns { quotas, periodEnd, exhaustedHint } or empty quotas when nothing usable.
 */
export function parseGrokCliBilling(
  billing,
  user = null,
  monthlyBilling = null,
  {
    monthlyLabel = "Monthly included",
    includePercent = false,
    encodeRemainingOnlyExhausted = false,
  } = {},
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
  const subscriptionAccess =
    hasActiveSubscription(user, config) || hasActiveSubscription(user, monthlyConfig);

  // Opt-in percent quota parsing (xAI OAuth usage payload).
  if (includePercent) {
    const productUsage = Array.isArray(config.productUsage)
      ? config.productUsage
      : Array.isArray(root.productUsage)
        ? root.productUsage
        : [];
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
    }

    const aggregatePercent = unwrapVal(
      config.creditUsagePercent ?? root.creditUsagePercent,
      NaN,
    );
    if (!quotas.Weekly && Number.isFinite(aggregatePercent)) {
      quotas.Weekly = makeQuota({
        used: Math.min(100, Math.max(0, aggregatePercent)),
        total: 100,
        resetAt: periodEnd,
      });
    }
  }

  // Current Grok Build responses expose included monthly usage at top level.
  const monthlyLimit = firstFinite(
    monthlyConfig.monthlyLimit,
    monthlyConfig.monthly_limit,
    monthlyRoot.monthlyLimit,
    monthlyRoot.monthly_limit,
    config.monthlyLimit,
    config.monthly_limit,
    root.monthlyLimit,
    root.monthly_limit,
  );
  // Preserve Grok CLI precedence: includedUsed/totalUsed before the newer bare used field.
  const monthlyUsed = firstFinite(
    monthlyConfig.includedUsed,
    monthlyConfig.included_used,
    monthlyRoot.includedUsed,
    monthlyRoot.included_used,
    monthlyConfig.totalUsed,
    monthlyConfig.total_used,
    monthlyRoot.totalUsed,
    monthlyRoot.total_used,
    monthlyConfig.used,
    monthlyRoot.used,
    config.includedUsed,
    config.included_used,
    root.includedUsed,
    root.included_used,
    config.totalUsed,
    config.total_used,
    root.totalUsed,
    root.total_used,
    config.used,
    root.used,
  );
  if (Number.isFinite(monthlyLimit) && monthlyLimit > 0 && Number.isFinite(monthlyUsed)) {
    quotas[monthlyLabel] = makeQuota({
      used: monthlyUsed,
      total: monthlyLimit,
      resetAt: monthlyPeriodEnd,
    });
  }

  // Prefer a useful positive source, but preserve a complete all-zero source as
  // the exhausted free/promo signal. Cap without used is not a usable quota.
  const onDemandSources = [
    { source: config, resetAt: periodEnd },
    { source: root, resetAt: periodEnd },
    { source: monthlyConfig, resetAt: monthlyPeriodEnd },
    { source: monthlyRoot, resetAt: monthlyPeriodEnd },
  ].map(({ source, resetAt }) => ({
    cap: unwrapVal(source.onDemandCap, NaN),
    used: unwrapVal(source.onDemandUsed, NaN),
    resetAt,
  }));
  const onDemand =
    onDemandSources.find(({ cap, used }) => cap > 0 && Number.isFinite(used)) ||
    onDemandSources.find(({ cap, used }) => cap === 0 && Number.isFinite(used));
  if (onDemand?.cap > 0) {
    quotas["On-demand"] = makeQuota({
      used: Math.max(0, onDemand.used),
      total: onDemand.cap,
      resetAt: onDemand.resetAt,
    });
  } else if (!subscriptionAccess && onDemand?.cap === 0) {
    // Cap 0 is the exhausted free/promo state (chat returns 402 spending-limit).
    // UI treats total===0 as unlimited, so use a synthetic 1/1 depleted row.
    quotas["On-demand"] = {
      used: 1,
      total: 1,
      remainingPercentage: 0,
      resetAt: onDemand.resetAt,
      unlimited: false,
    };
  }

  // Prepaid top-up balance (remaining credits; no fixed allotment known).
  const prepaidSources = [
    { value: firstFinite(config.prepaidBalance, root.prepaidBalance), resetAt: periodEnd },
    { value: firstFinite(monthlyConfig.prepaidBalance, monthlyRoot.prepaidBalance), resetAt: monthlyPeriodEnd },
  ];
  const prepaid = prepaidSources.find(({ value }) => value > 0);
  if (prepaid) {
    quotas["Prepaid"] = {
      used: 0,
      total: prepaid.value,
      remainingPercentage: 100,
      resetAt: prepaid.resetAt,
      unlimited: false,
    };
  }

  // Opportunistic richer credit envelopes (future / other account types)
  const creditBags = [
    ...[
      root.credits,
      root.creditBalance,
      root.usage,
      config.credits,
      config.includedCredits,
      config.subscriptionCredits,
    ].map((bag) => ({ bag, resetAt: periodEnd })),
    ...[
      monthlyRoot.credits,
      monthlyRoot.creditBalance,
      monthlyRoot.usage,
      monthlyConfig.credits,
      monthlyConfig.includedCredits,
      monthlyConfig.subscriptionCredits,
    ].map((bag) => ({ bag, resetAt: monthlyPeriodEnd })),
  ]
    .filter(({ bag }) => bag && typeof bag === "object" && !Array.isArray(bag))
    .sort((a, b) => {
      const useful = ({ bag }) => firstFinite(
        bag.total,
        bag.limit,
        bag.cap,
        bag.allocation,
        bag.amount,
        bag.remaining,
        bag.balance,
        bag.left,
      ) > 0;
      return Number(useful(b)) - Number(useful(a));
    });

  for (const { bag, resetAt } of creditBags) {
    const total = unwrapVal(
      bag.total ?? bag.limit ?? bag.cap ?? bag.allocation ?? bag.amount,
      NaN,
    );
    const used = unwrapVal(bag.used ?? bag.spent ?? bag.consumed, NaN);
    const remaining = unwrapVal(bag.remaining ?? bag.balance ?? bag.left, NaN);
    if (Number.isFinite(total) && total > 0) {
      const resolvedUsed = Number.isFinite(used)
        ? used
        : Number.isFinite(remaining)
          ? Math.max(0, total - remaining)
          : 0;
      if (!quotas.Credits) {
        quotas.Credits = makeQuota({
          used: resolvedUsed,
          total,
          resetAt: parseResetTime(bag.resetAt || bag.resetsAt || bag.end) || resetAt,
        });
      }
    } else if (Number.isFinite(remaining) && remaining >= 0 && !quotas.Credits) {
      quotas.Credits = {
        used: remaining > 0 || !encodeRemainingOnlyExhausted ? 0 : 1,
        total: remaining > 0 ? remaining : 1,
        remainingPercentage: remaining > 0 ? 100 : 0,
        resetAt,
        unlimited: false,
      };
    }
  }

  // Exhausted when every finite quota bar is at 0% remaining
  const exhausted =
    Object.keys(quotas).length > 0 &&
    Object.values(quotas).every(
      (q) => q.unlimited !== true && (q.remainingPercentage ?? 100) <= 0,
    );

  const planConfig = subscriptionTier(null, monthlyConfig)
    ? monthlyConfig
    : subscriptionTier(null, config) || config.isUnifiedBillingUser === true
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
}

async function readJson(response, acceptEmpty = false) {
  if (!response?.ok) return null;
  const reader = response.body?.getReader?.();
  let timeoutId;
  const readBody = reader
    ? (async () => {
        const decoder = new TextDecoder();
        let text = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) return JSON.parse(text + decoder.decode());
          text += decoder.decode(value, { stream: true });
        }
      })()
    : response.json();
  const body = await Promise.race([
    readBody.catch(() => null),
    new Promise((resolve) => {
      timeoutId = setTimeout(async () => {
        await (reader?.cancel?.() || response.body?.cancel?.())?.catch?.(() => {});
        resolve(null);
      }, 10000);
    }),
  ]).finally(() => clearTimeout(timeoutId));
  return hasUsableBilling(body) || (acceptEmpty && body && typeof body === "object" && !Array.isArray(body))
    ? body
    : null;
}

async function consumeFailedResponse(response) {
  if (response && !response.ok) await response.body?.cancel?.().catch(() => {});
}

async function getGrokUsage({
  provider,
  accessToken,
  providerSpecificData,
  proxyOptions,
  includeMonthly,
  includePercent,
  monthlyLabel,
  encodeRemainingOnlyExhausted,
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
      fetchWithTimeout(creditsUrl, { method: "GET", headers }, 10000, proxyOptions),
      includeMonthly && monthlyUrl
        ? fetchWithTimeout(monthlyUrl, { method: "GET", headers }, 10000, proxyOptions)
        : Promise.resolve(null),
      userUrl
        ? fetchWithTimeout(userUrl, { method: "GET", headers }, 10000, proxyOptions)
        : Promise.resolve(null),
    ]);

    const creditsResponse = creditsResult.status === "fulfilled" ? creditsResult.value : null;
    const monthlyResponse = monthlyResult.status === "fulfilled" ? monthlyResult.value : null;
    const userResponse = userResult.status === "fulfilled" ? userResult.value : null;
    const billingResponses = [creditsResponse, monthlyResponse].filter(Boolean);

    // Only parseable object bodies count as successful independent billing sources.
    const [credits, monthly, user] = await Promise.all([
      readJson(creditsResponse, !includeMonthly),
      readJson(monthlyResponse),
      readJson(userResponse, true),
    ]);
    const hasParsedBilling = !!(credits || monthly);

    if (!hasParsedBilling) {
      if (billingResponses.some((response) => response.status === 401 || response.status === 403)) {
        await Promise.all([...billingResponses, userResponse].map(consumeFailedResponse));
        return { message: `${providerName} authentication expired. Please re-authorize.` };
      }
      // 200 with an empty or unparseable body must not suppress an auth failure or
      // fall through to subscription/empty-quota messages.
      if (billingResponses.some((response) => response.ok)) {
        await Promise.all([...billingResponses, userResponse].map(consumeFailedResponse));
        return { message: `${providerName} billing response was not JSON.` };
      }
      if (billingResponses.length === 0) {
        return { message: `${providerName} billing API error (network)` };
      }
      // Preserve upstream error body when a single billing response fails (Grok CLI path).
      if (billingResponses.length === 1) {
        const failed = billingResponses[0];
        const errText = await failed.text().catch(() => "");
        const trimmed = errText ? `: ${errText.slice(0, 200)}` : "";
        return { message: `${providerName} billing API error (${failed.status})${trimmed}` };
      }
      await Promise.all([...billingResponses, userResponse].map(consumeFailedResponse));
      const statuses = billingResponses.map((response) => response.status).join(", ");
      return { message: `${providerName} billing API error (${statuses})` };
    }

    await Promise.all([...billingResponses, userResponse].map(consumeFailedResponse));

    const parsed = parseGrokCliBilling(
      credits,
      user,
      monthly,
      { includePercent, monthlyLabel, encodeRemainingOnlyExhausted },
    );

    if (Object.keys(parsed.quotas).length === 0) {
      const emptyMessage = parsed.subscriptionAccess
        ? provider === "xai"
          ? "xAI subscription access is active, but no numeric quota was returned."
          : "Subscription access is active; Grok does not expose a numeric included quota."
        : provider === "xai"
          ? `${providerName} connected, but no credit allotment was returned.`
          : "Grok Build connected, but no credit allotment was returned. Free promo may be exhausted.";
      return {
        plan: parsed.plan,
        message: emptyMessage,
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
    encodeRemainingOnlyExhausted: true,
  });
}
