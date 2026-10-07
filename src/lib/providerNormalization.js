import { AI_PROVIDERS } from "../shared/constants/providers.js";

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const trimmed = provider.trim();
  if (AI_PROVIDERS[trimmed]) return trimmed;

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (AI_PROVIDERS[slug]) return slug;

  const providerByName = Object.values(AI_PROVIDERS).find(
    (entry) => entry.name?.toLowerCase() === trimmed.toLowerCase()
  );
  return providerByName?.id || trimmed;
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  if (provider === "ollama-local") {
    const baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    if (baseUrl) next.baseUrl = baseUrl;
  }

  // The registry baseUrl carries {accountId}, so the executor throws at request
  // time without it. Creating the connection anyway leaves a permanently broken
  // row that only surfaces as a 502 on first use — reject it at the boundary
  // instead. Accept the id from the body too: bulk-add and single-add both use
  // the flat field, and providerSpecificData may be absent entirely.
  if (provider === "cloudflare-ai") {
    const accountId = String(next.accountId || body.accountId || "").trim();
    if (!accountId) {
      const err = new Error("Cloudflare requires an Account ID (accountId).");
      err.status = 400;
      throw err;
    }
    next.accountId = accountId;
  }

  return Object.keys(next).length > 0 ? next : null;
}
