import { getUsageForProvider } from "open-sse/services/usage.js";
import { getModelInfo } from "../services/model.js";
import * as log from "../utils/logger.js";

// A Claude 429 carries no reset hint at all — verified against a live exhausted
// account: the response has `x-should-retry: true` and a body of
// `{"type":"rate_limit_error","message":"Error"}`, with no `retry-after` and no
// `anthropic-ratelimit-unified-*-reset`. Falling back to the error-rule backoff
// then locks the model for 2s and retries it over and over for the whole window
// (167 times in 6h observed).
//
// The reset is available, just from a different endpoint: the OAuth usage API
// reports model-scoped weekly limits as
//   { kind: "weekly_scoped", percent: 100, resets_at: "...",
//     scope: { model: { display_name: "Fable" } } }
// which `getClaudeUsage` surfaces as the quota row `weekly fable (7d)`.
//
// Same shape as handleAntigravityQuotaError: ask the provider what the real
// boundary is before writing a lock.

/** The display name the usage API reports for a registry model id ("claude-fable-5-2" → "fable"). */
async function usageModelName(model) {
  const info = await getModelInfo(model);
  const name = String(info?.name || "");
  // "Claude Fable 5.2" → "fable"; fall back to the id without its version tail.
  const family = name.match(/^Claude\s+([A-Za-z]+)/i)?.[1];
  return (family || String(model).replace(/^claude-/, "").replace(/[-.].*$/, "")).toLowerCase();
}

/**
 * Look up the reset time of the exhausted quota window for a Claude model.
 * @returns {Promise<number|null>} epoch ms, or null when nothing usable was found
 */
export async function resolveClaudeQuotaReset(credentials, model, proxyOptions = null) {
  if (!credentials?.accessToken) return null;
  try {
    const usage = await getUsageForProvider({
      id: credentials.connectionId,
      provider: "claude",
      accessToken: credentials.accessToken,
      providerSpecificData: credentials.providerSpecificData,
    }, proxyOptions, { force: true });
    const quotas = usage?.quotas;
    if (!quotas) return null;

    // Exhausted = the bucket is at (or past) 100% used and knows when it resets.
    // Only an exhausted bucket explains this 429; a healthy one would mean the
    // error came from something else and must not be parked on a real window.
    const exhausted = Object.entries(quotas).filter(([, q]) =>
      q && Number(q.remainingPercentage) <= 0 && q.resetAt && new Date(q.resetAt).getTime() > Date.now());
    if (exhausted.length === 0) return null;

    const wanted = `weekly ${await usageModelName(model)} (7d)`;
    // Prefer the window scoped to this model; otherwise any exhausted window is
    // still a better answer than the 2s backoff.
    const [key, quota] = exhausted.find(([k]) => k === wanted) || exhausted[0];
    const resetAt = new Date(quota.resetAt).getTime();
    log.info("CLAUDE_QUOTA", `${credentials.connectionId?.slice(0, 8)} | ${model} → ${key} until ${quota.resetAt}`);
    return resetAt;
  } catch (error) {
    log.warn("CLAUDE_QUOTA", `${model} | usage lookup failed: ${error.message}`);
    return null;
  }
}
