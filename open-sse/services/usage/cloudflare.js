/**
 * Cloudflare Workers AI usage.
 *
 * No upstream quota API is usable here: Cloudflare's GraphQL analytics lags
 * 9-15 minutes (measured), which is far too slow to reflect what the cap is
 * about to block. Count from the local ledger instead — the same source
 * cloudflareFreeTier.js enforces on, so the dashboard and the brake agree.
 *
 * The daily free allocation is 10,000 neurons, resetting at 00:00 UTC.
 * Callers expect { quotas: { name: { used, total, resetAt, ... } } }.
 */

import { dailyNeurons, nextUtcReset, FREE_NEURONS_PER_DAY, utcDayStart } from "@/lib/cloudflareFreeTier.js";
import { getSettings } from "@/lib/localDb.js";

/**
 * @param {string|null|undefined} connectionId
 * @param {object|null} proxyOptions
 */
export async function getCloudflareUsage(connectionId, proxyOptions = null) {
  if (!connectionId) {
    return { message: "Cloudflare connection id not available." };
  }

  try {
    const [used, settings] = await Promise.all([
      dailyNeurons(connectionId),
      getSettings(),
    ]);
    const capped = settings?.cloudflareFreeOnly === true;

    const quotas = {
      "Daily neurons (free)": {
        used: Math.min(used, FREE_NEURONS_PER_DAY),
        total: FREE_NEURONS_PER_DAY,
        remainingPercentage: Math.max(0, 100 - (used / FREE_NEURONS_PER_DAY) * 100),
        resetAt: nextUtcReset(),
        unlimited: false,
      },
    };

    // Show the overage once it happens, so "capped" vs "billing" is visible
    // rather than silently rounded up to 100% spent.
    if (used > FREE_NEURONS_PER_DAY) {
      quotas["Billed overage"] = {
        used: used - FREE_NEURONS_PER_DAY,
        total: used,
        remainingPercentage: 0,
        resetAt: nextUtcReset(),
        unlimited: false,
      };
    }

    return {
      plan: capped ? "Workers AI (free cap)" : "Workers AI (billing overage)",
      quotas,
      since: utcDayStart(),
    };
  } catch (error) {
    return { message: `Cloudflare usage error: ${error.message}` };
  }
}
