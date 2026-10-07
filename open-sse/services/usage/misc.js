/**
 * Misc usage handlers (iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";

export { getGlmUsage } from "./glm.js";


// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

const OLLAMA_LIMIT_WINDOWS = {
  session: "Session (5h)",
  weekly: "Weekly (7d)",
  monthly: "Monthly",
};

/**
 * Per-model request counts for one Ollama connection since `since`, busiest
 * first, capped so a wide model list cannot wall the quota card.
 * Returns [] on any failure — a missing breakdown must not sink the whole row.
 *
 * @param {string|undefined} connectionId
 * @param {string|undefined} since ISO timestamp from the API window
 */
async function ollamaModelsByRequests(connectionId, since) {
  if (!connectionId || !since) return [];
  try {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const rows = db.all(
      `SELECT model, COUNT(*) AS n FROM usageHistory
        WHERE provider = 'ollama' AND connectionId = ? AND timestamp >= ?
        GROUP BY model ORDER BY n DESC LIMIT 8`,
      [connectionId, since]
    );
    return rows
      .map((r) => ({ name: r.model, requestCount: Number(r.n) }))
      .filter((r) => r.name && Number.isFinite(r.requestCount) && r.requestCount > 0);
  } catch {
    return [];
  }
}

function addUtcMonths(date, months) {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year, month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ));
}

// Free plan: "usage resets monthly from the date you signed up" (ollama.com/pricing).
function nextMonthlyResetFromSignup(createdAt, now = new Date()) {
  const anchor = new Date(createdAt);
  if (Number.isNaN(anchor.getTime())) return null;
  const elapsedMonths = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + (now.getUTCMonth() - anchor.getUTCMonth());
  for (let i = Math.max(0, elapsedMonths); i <= elapsedMonths + 1; i++) {
    const candidate = addUtcMonths(anchor, i);
    if (candidate > now) return candidate.toISOString();
  }
  return null;
}

/**
 * Ollama Cloud Usage
 *
 * GET https://ollama.com/api/usage — request counts only. Ollama removed the
 *   `limits.<window>.usage` ratios this used to read, so there is no
 *   percentage left to draw a limit bar from: the response is now
 *   {range, granularity, totals:{request_count}, buckets:[…]} and nothing else.
 *   What is reported instead is the request_count total for the window, marked
 *   unlimited so the UI shows a count rather than a bogus "0% used" bar.
 * POST https://ollama.com/api/me — plan label (fail-open).
 * Auth: Authorization: Bearer <apiKey>
 *
 * Ollama meters usage in tokens/credits against a monthly allowance (Pro $60,
 * Max $300, resetting on the subscription date), but exposes no endpoint that
 * reports the consumed share — /api/me carries Plan and CreatedAt only. The
 * signup-date reset is still derived and shown, since the allowance does reset
 * then even though the amount spent is not knowable from here.
 */
export async function getOllamaUsage(apiKey, providerSpecificData, proxyOptions = null, connectionId = null) {
  if (!apiKey) {
    return { message: "Ollama Cloud API key not available." };
  }

  try {
    const response = await proxyAwareFetch("https://ollama.com/api/usage?range=30d", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Ollama Cloud API key invalid or expired." };
    }

    if (!response.ok) {
      return { message: `Ollama Cloud usage API error (${response.status}).` };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { message: "Ollama Cloud usage response was not JSON." };
    }

    // Best-effort plan label from /api/me
    const me = await proxyAwareFetch("https://ollama.com/api/me", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Length": "0",
      },
    }, proxyOptions).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const planRaw = typeof me?.Plan === "string" ? me.Plan : "";
    const plan = planRaw
      ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1).toLowerCase()
      : "Ollama Cloud";

    const monthlyResetAt = me?.CreatedAt ? nextMonthlyResetFromSignup(me.CreatedAt) : null;

    const label = data?.range === "24h"
      ? OLLAMA_LIMIT_WINDOWS.session
      : data?.range === "7d"
        ? OLLAMA_LIMIT_WINDOWS.weekly
        : OLLAMA_LIMIT_WINDOWS.monthly;

    const requestCount = Number(data?.totals?.request_count);
    if (!Number.isFinite(requestCount)) {
      return {
        plan,
        message: "Ollama Cloud connected. No usage limits reported.",
        quotas: {},
      };
    }

    // Ollama reports a count, not a ceiling — there is no denominator left to
    // draw a percentage against, so mark it unlimited and let the table show
    // the raw count instead of a meaningless 0% bar.
    //
    // The breakdown is per model rather than per day: /api/usage only buckets by
    // time (group_by=model is rejected with a 400), and a month of daily rows is
    // unreadable. usageHistory records the model on every request, so count from
    // there. It drifts a few percent below the API total — calls that never
    // reached this gateway, plus rows older than retention — so the API figure
    // stays the headline and only the split comes from local history.
    const quotas = {
      [label]: {
        used: requestCount,
        total: 0,
        resetAt: monthlyResetAt,
        unlimited: true,
        models: await ollamaModelsByRequests(connectionId, data?.from),
      },
    };

    return { plan, quotas };
  } catch (error) {
    return { message: `Ollama Cloud error: ${error.message}` };
  }
}



/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    // Vercel returns numeric strings; coerce safely.
    const balance = Number(data?.balance) || 0;
    const totalUsed = Number(data?.total_used) || 0;

    // Vercel gives $5/month free credit. The API doesn't return the
    // monthly allocation so we use the known constant as the denominator.
    const MONTHLY_CREDIT = 5;
    const remainingPercentage = (balance / MONTHLY_CREDIT) * 100;

    if (balance <= 0 && totalUsed <= 0) {
      return {
        plan: "Pay-as-you-go",
        message: "Vercel AI Gateway connected. No credit allocation found (BYOK or unfunded account).",
        quotas: {},
      };
    }

    // "Used (USD)": how much has been spent this month (no fixed cap → unlimited).
    // "Remaining (USD)": balance remaining out of the $5 monthly allocation.
    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Used (USD)": {
          used: totalUsed,
          total: 0,
          remaining: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
        "Remaining (USD)": {
          used: balance,
          total: MONTHLY_CREDIT,
          remaining: balance,
          remainingPercentage,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

export async function getCharmUsage(apiKey, proxyOptions = null) {
  if (!apiKey) return { message: "Charm API key not available." };

  try {
    const response = await proxyAwareFetch(U("charm").url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Charm API key invalid or expired." };
    }
    if (!response.ok) {
      return { message: `Charm credits API error (${response.status}).` };
    }

    const data = await response.json().catch(() => null);
    const balance = Number(data?.balance);
    if (!Number.isFinite(balance) || balance < 0) {
      return { message: "Charm credits response did not contain a valid balance." };
    }

    // Credit-balance shape, matching getDeepseekUsage: `total` IS the balance
    // (QuotaTable renders it), and isCreditBalance switches the row to currency
    // display rather than a percentage bar.
    return {
      plan: "Charm",
      quotas: {
        "Balance (Hypercredits)": {
          used: 0,
          total: balance,
          remaining: balance,
          remainingPercentage: balance > 0 ? 100 : 0,
          resetAt: null,
          isCreditBalance: true,
          currency: "Hypercredits",
        },
      },
    };
  } catch (error) {
    return { message: `Charm error: ${error.message}` };
  }
}

export async function getQoderUsage(accessToken, proxyOptions = null, providerId = "qoder") {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      U(providerId).url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    // Quota records live under `quotas`; scalar metadata
    // (totalUsagePercentage, isQuotaExceeded, expiresAt) are surfaced as
    // siblings so the dashboard parser doesn't try to render them as rows.
    const userQuota = body.userQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total.
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const resetAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
      },
    };
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}
