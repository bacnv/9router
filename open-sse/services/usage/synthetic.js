/**
 * Synthetic usage — GET https://api.synthetic.new/v2/quotas
 * Auth: Bearer <apiKey>. The call itself does not count against the quota.
 * Docs: https://dev.synthetic.new/docs/synthetic/quotas
 *
 * Response (2026-10-27):
 *   { subscription: { limit, requests, renewsAt },
 *     search: { hourly: { limit, requests, renewsAt } },
 *     planWeeklyLimit: { percentRemaining, nextRegenAt, nextRegenPercent } }
 *
 * The subscription window is a request count rendered as a percentage; the
 * weekly plan window already arrives as a percentage.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";

const PLAN = "Synthetic";

function percentRow(name, limit, used, resetAt) {
  const total = toFiniteNumber(limit, 0);
  if (total <= 0) return null;
  const spent = Math.max(0, Math.min(total, toFiniteNumber(used, 0)));
  const remaining = total - spent;
  return {
    name,
    used: spent,
    total,
    percentage: Math.round((spent / total) * 100),
    colorPercentage: Math.round((remaining / total) * 100),
    percentageIsUsed: true,
    remaining,
    remainingPercentage: Math.round((remaining / total) * 1000) / 10,
    resetAt: parseResetTime(resetAt),
    unlimited: false,
  };
}

export async function getSyntheticUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Synthetic API key not available. Add a key to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      U("synthetic").url || "https://api.synthetic.new/v2/quotas",
      {
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return { plan: PLAN, message: "Synthetic authentication failed. API key invalid or expired." };
    }
    if (!response.ok) {
      return { plan: PLAN, message: `Synthetic usage API error (${response.status}).` };
    }

    const data = await response.json().catch(() => null);
    const sub = data?.subscription;
    if (!sub || typeof sub !== "object") {
      return { plan: PLAN, message: "No subscription quota in the Synthetic response." };
    }

    const quotas = {};
    const subRow = percentRow("Subscription requests", sub.limit, sub.requests, sub.renewsAt);
    // Two keys on purpose: upstream's contract test reads quotas.Requests,
    // the fork's dashboard rows (and older caches) read the display name.
    if (subRow) { quotas.Requests = subRow; quotas["Subscription requests"] = subRow; }

    const searchRow = percentRow(
      "Search (hourly)",
      data?.search?.hourly?.limit,
      data?.search?.hourly?.requests,
      data?.search?.hourly?.renewsAt,
    );
    if (searchRow) { quotas.Search = searchRow; quotas["Search (hourly)"] = searchRow; }

    const weekly = data?.planWeeklyLimit;
    const percentRemaining = toFiniteNumber(weekly?.percentRemaining, NaN);
    if (Number.isFinite(percentRemaining)) {
      const remaining = Math.round(percentRemaining * 10) / 10;
      const weeklyRow = {
        name: "Plan window (weekly)",
        used: Math.round((100 - remaining) * 10) / 10,
        total: 100,
        percentage: Math.round((100 - remaining) * 10) / 10,
        colorPercentage: Math.round(remaining * 10) / 10,
        percentageIsUsed: true,
        remaining,
        remainingPercentage: remaining,
        resetAt: parseResetTime(weekly?.nextRegenAt),
        unlimited: false,
      };
      quotas.PlanWeekly = weeklyRow;
      quotas["Plan window (weekly)"] = weeklyRow;
    }

    // A limit of 0 means the key has no subscription window — never render it
    // as "unlimited", which reads as an unbounded plan.
    if (!quotas.Requests) {
      return { plan: PLAN, message: "No Synthetic subscription quota found for this key." };
    }

    return { plan: PLAN, quotas };
  } catch (error) {
    return { plan: PLAN, message: `Synthetic error: ${error.message}` };
  }
}
