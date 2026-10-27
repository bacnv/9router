/**
 * Synthetic usage — GET https://api.synthetic.new/v2/quotas
 * Auth: Bearer <apiKey>
 *
 * Response (2026-10-27):
 *   { subscription: { limit, requests, renewsAt },
 *     search: { hourly: { limit, requests, renewsAt } },
 *     planWeeklyLimit: { percentRemaining, nextRegenAt, nextRegenPercent } }
 *
 * The subscription window is a request count, so the row is rendered as a
 * percentage like opencode-go's; the weekly plan window is already a percentage
 * and is surfaced as a credit-style remaining figure.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";
import { parseResetTime, toFiniteNumber } from "./shared.js";

const PLAN = "Synthetic";

function percentRow(limit, used, resetAt) {
  const total = toFiniteNumber(limit, 0);
  if (total <= 0) return null;
  const spent = Math.max(0, Math.min(total, toFiniteNumber(used, 0)));
  const remaining = total - spent;
  return {
    used: spent,
    total,
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
      return { message: "Synthetic API key invalid or expired." };
    }
    if (!response.ok) {
      return { message: `Synthetic usage API error (${response.status}).` };
    }

    const data = await response.json().catch(() => null);
    const sub = data?.subscription;
    if (!sub || typeof sub !== "object") {
      return { plan: PLAN, message: "Synthetic usage response did not contain quota data." };
    }

    const quotas = {};
    const subRow = percentRow(sub.limit, sub.requests, sub.renewsAt);
    if (subRow) quotas["Subscription requests"] = subRow;

    const searchRow = percentRow(data?.search?.hourly?.limit, data?.search?.hourly?.requests, data?.search?.hourly?.renewsAt);
    if (searchRow) quotas["Search (hourly)"] = searchRow;

    const weekly = data?.planWeeklyLimit;
    const percentRemaining = toFiniteNumber(weekly?.percentRemaining, NaN);
    if (Number.isFinite(percentRemaining)) {
      const remaining = Math.round(percentRemaining * 10) / 10;
      quotas["Plan window (weekly)"] = {
        used: Math.round((100 - remaining) * 10) / 10,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: parseResetTime(weekly?.nextRegenAt),
        unlimited: false,
      };
    }

    if (Object.keys(quotas).length === 0) {
      return { plan: PLAN, message: "Synthetic usage response did not contain valid quota data." };
    }

    return { plan: PLAN, quotas };
  } catch (error) {
    return { message: `Synthetic usage error: ${error.message}` };
  }
}
