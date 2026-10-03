/**
 * Cloudflare Workers AI free-tier cap — local neuron counter.
 *
 * Workers Paid does NOT stop at the daily free allocation (10,000 neurons,
 * reset 00:00 UTC); it silently bills past it at $0.011/1,000 neurons.
 * Cloudflare's own analytics API lags 9-15 minutes (measured), so it cannot
 * act as a brake. usageHistory is written synchronously on every request, so
 * count neurons from there instead and block the connection once the day's
 * free allocation is spent.
 *
 * A neuron is just a currency unit — 1,000 neurons = $0.011 — so
 * neurons = cost / NEURON_USD. That keeps the count model-agnostic and needs
 * no per-model neuron table.
 */

import { getAdapter } from "./db/driver.js";
import { getSettings } from "./localDb.js";

export const NEURON_USD = 0.011 / 1000; // $ per neuron
export const FREE_NEURONS_PER_DAY = 10_000;

// ponytail: 5s of staleness. A burst can overshoot by a few hundred neurons
// (~4 per clef-flash call) before the next read catches it — noise against a
// 10k budget. Tighten if this ever guards a tighter cap.
const CACHE_TTL_MS = 5_000;
const cache = new Map(); // connectionId -> { used, expiresAt }

/** Start of the current UTC day — Cloudflare resets limits at 00:00 UTC. */
export function utcDayStart(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** Next 00:00 UTC — when the free allocation refills. */
export function nextUtcReset(now = Date.now()) {
  return new Date(new Date(utcDayStart(now)).getTime() + 86_400_000).toISOString();
}

export function neuronsFromCost(costUsd) {
  const cost = Number(costUsd);
  return Number.isFinite(cost) && cost > 0 ? cost / NEURON_USD : 0;
}

export function isExhausted(usedNeurons) {
  return usedNeurons >= FREE_NEURONS_PER_DAY;
}

function createDefaultDeps() {
  return { getAdapter, getSettings };
}

/** Neurons spent today (UTC) on one connection, counted from usageHistory. */
export async function dailyNeurons(connectionId, deps = createDefaultDeps()) {
  const hit = cache.get(connectionId);
  if (hit && hit.expiresAt > Date.now()) return hit.used;

  const db = await deps.getAdapter();
  const row = db.get(
    `SELECT COALESCE(SUM(cost), 0) AS cost FROM usageHistory
      WHERE provider = 'cloudflare-ai' AND connectionId = ? AND timestamp >= ?`,
    [connectionId, utcDayStart()]
  );
  const used = neuronsFromCost(row?.cost);
  cache.set(connectionId, { used, expiresAt: Date.now() + CACHE_TTL_MS });
  return used;
}

/**
 * Which of these cloudflare-ai connections have spent the day's free
 * allocation. Empty set when the cap is disabled, so the auth pre-filter
 * costs nothing by default.
 */
export async function getExhaustedConnections(connections, deps = createDefaultDeps()) {
  const settings = await deps.getSettings();
  if (settings?.cloudflareFreeOnly !== true) return new Set();

  const exhausted = new Set();
  for (const c of connections) {
    if (isExhausted(await dailyNeurons(c.id, deps))) exhausted.add(c.id);
  }
  return exhausted;
}

/** Test seam — the cache is module-global and survives between cases. */
export function clearCloudflareUsageCache() {
  cache.clear();
}
