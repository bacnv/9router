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

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";
import {
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_USER_AGENT,
  GROK_CLI_VERSION,
} from "../../config/grokCli.js";

const USAGE = U("grok-cli");
const BILLING_URL = USAGE.url || "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const USER_URL = USAGE.userUrl || "https://cli-chat-proxy.grok.com/v1/user?include=subscription";

/** Unwrap protobuf-json `{ val: n }` or plain numbers/strings. */
function unwrapVal(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "object" && !Array.isArray(value) && "val" in value) {
    return toFiniteNumber(value.val, fallback);
  }
  return toFiniteNumber(value, fallback);
}

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
  const subscriptionAccess =
    hasActiveSubscription(user, config) || hasActiveSubscription(user, monthlyConfig);

  // Opt-in percent quota parsing (xAI OAuth usage payload).
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

  // Current Grok Build responses expose included monthly usage at top level.
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

  // Primary: on-demand spending window (subscription / promo credits)
  const onDemandCap = unwrapVal(config.onDemandCap ?? root.onDemandCap, NaN);
  const onDemandUsed = unwrapVal(config.onDemandUsed ?? root.onDemandUsed, NaN);
  if (Number.isFinite(onDemandCap) && onDemandCap > 0) {
    const used = Number.isFinite(onDemandUsed) ? Math.max(0, onDemandUsed) : 0;
    quotas["On-demand"] = makeQuota({
      used,
      total: onDemandCap,
      resetAt: periodEnd,
    });
  } else if (
    !subscriptionAccess &&
    Number.isFinite(onDemandCap) &&
    onDemandCap === 0 &&
    Number.isFinite(onDemandUsed)
  ) {
    // Cap 0 is the exhausted free/promo state (chat returns 402 spending-limit).
    // UI treats total===0 as unlimited, so use a synthetic 1/1 depleted row.
    quotas["On-demand"] = {
      used: 1,
      total: 1,
      remainingPercentage: 0,
      resetAt: periodEnd,
      unlimited: false,
    };
  }

  // Prepaid top-up balance (remaining credits; no fixed allotment known)
  const prepaid = unwrapVal(config.prepaidBalance ?? root.prepaidBalance, NaN);
  if (Number.isFinite(prepaid) && prepaid > 0) {
    // Show full bar against the current balance (0 spent of this remaining pot).
    quotas["Prepaid"] = {
      used: 0,
      total: prepaid,
      remainingPercentage: 100,
      resetAt: null,
      unlimited: false,
    };
  }

  // Opportunistic richer credit envelopes (future / other account types)
  const creditBags = [
    root.credits,
    root.creditBalance,
    root.usage,
    config.credits,
    config.includedCredits,
    config.subscriptionCredits,
  ].filter((bag) => bag && typeof bag === "object" && !Array.isArray(bag));

  for (const bag of creditBags) {
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
          resetAt: parseResetTime(bag.resetAt || bag.resetsAt || bag.end) || periodEnd,
        });
      }
    } else if (Number.isFinite(remaining) && remaining >= 0 && !quotas.Credits) {
      quotas.Credits = {
        used: 0,
        total: remaining > 0 ? remaining : 1,
        remainingPercentage: remaining > 0 ? 100 : 0,
        resetAt: periodEnd,
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

  const planConfig =
    subscriptionTier(null, config) || config.isUnifiedBillingUser === true
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

/**
 * @param {string} accessToken
 * @param {object|null} providerSpecificData
 * @param {object|null} proxyOptions
 */
export async function getGrokCliUsage(accessToken, providerSpecificData = null, proxyOptions = null) {
  if (!accessToken) {
    return { message: "Grok CLI access token not available." };
  }

  const headers = buildGrokCliHeaders(accessToken, providerSpecificData);

  try {
    // Fetch billing + user profile in parallel (same pattern as official CLI startup)
    const [billingRes, userRes] = await Promise.all([
      proxyAwareFetch(
        BILLING_URL,
        { method: "GET", headers },
        proxyOptions,
      ),
      proxyAwareFetch(
        USER_URL,
        { method: "GET", headers },
        proxyOptions,
      ).catch(() => null),
    ]);

    if (billingRes.status === 401 || billingRes.status === 403) {
      return { message: "Grok CLI authentication expired. Please re-authorize." };
    }

    if (!billingRes.ok) {
      const errText = await billingRes.text().catch(() => "");
      const trimmed = errText ? `: ${errText.slice(0, 200)}` : "";
      return { message: `Grok CLI billing API error (${billingRes.status})${trimmed}` };
    }

    const billing = await billingRes.json().catch(() => null);
    if (!billing || typeof billing !== "object") {
      return { message: "Grok CLI billing response was not JSON." };
    }

    let user = null;
    if (userRes?.ok) {
      user = await userRes.json().catch(() => null);
    }

    const parsed = parseGrokCliBilling(billing, user);

    if (!parsed.quotas || Object.keys(parsed.quotas).length === 0) {
      return {
        plan: parsed.plan,
        message: parsed.subscriptionAccess
          ? "Subscription access is active; Grok does not expose a numeric included quota."
          : "Grok Build connected, but no credit allotment was returned. Free promo may be exhausted.",
        quotas: {},
      };
    }

    // Dashboard hides QuotaTable whenever `message` is set, so only attach a
    // message when there are no quota rows to render. Depleted accounts keep
    // the 0% On-demand bar without a blocking message.
    return {
      plan: parsed.plan,
      quotas: parsed.quotas,
    };
  } catch (error) {
    return { message: `Grok CLI usage error: ${error.message}` };
  }
}
