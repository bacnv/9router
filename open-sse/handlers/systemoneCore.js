import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { PROVIDER_MEDIA } from "../providers/index.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { generateSessionId } from "../executors/opencode-zen.js";

/**
 * Core System One (Jev) handler — native decision payload pass-through.
 * URL/headers come from the registry's systemoneConfig; body and JSON response
 * are forwarded untouched (decision models have no chat translation layer).
 *
 * @returns {Promise<{ success: boolean, response: Response, usage?: object, status?: number, error?: string }>}
 */
export async function handleSystemoneCore({
  body,
  modelInfo,
  credentials,
  log,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;
  const cfg = PROVIDER_MEDIA[provider]?.systemoneConfig;
  // Registry baseUrl may carry placeholders: {accountId} (Cloudflare accounts path)
  // and {model} for path-style lanes that take the model in the URL, not the body.
  const accountId = credentials?.providerSpecificData?.accountId;
  const rawUrl = credentials?.providerSpecificData?.baseUrl || cfg?.baseUrl;
  if (!rawUrl) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support System One.`
    );
  }
  if (rawUrl.includes("{accountId}") && !accountId) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' requires accountId in providerSpecificData`
    );
  }
  const modelInUrl = rawUrl.includes("{model}");
  const targetUrl = rawUrl
    .replace("{accountId}", accountId || "")
    .replace(/\{model\}/g, model);

  // Validate input at the trust boundary; question-level shape is upstream's job.
  if (body.state === undefined || body.state === null) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: state");
  }
  if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: questions");
  }

  // noAuth free lanes carry accessToken "public" from the credential stub.
  const token = credentials?.apiKey || credentials?.accessToken;
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cfg.headers || {}),
    // Zen lanes expect the official client session header on every request.
    "x-opencode-session": generateSessionId(),
  };
  // Path-style lanes (Cloudflare /ai/run/{model}) reject a model field in the body —
  // inputs go unwrapped. Body-style lanes (OpenCode Zen, OpenRouter) require it, and
  // Cloudflare validates the body model as a short selector (e.g. "clef-flash").
  const requestBody = modelInUrl
    ? (() => { const { model: _omit, ...rest } = body; return rest; })()
    : { ...body, model: getModelUpstreamId(provider, model) || model };

  log?.debug?.("SYSTEMONE", `${provider.toUpperCase()} | ${model}`);

  let providerResponse;
  try {
    providerResponse = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      ...(typeof AbortSignal?.timeout === "function"
        ? { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) }
        : {}),
    });
  } catch (error) {
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("SYSTEMONE", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse, null, provider);
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("SYSTEMONE", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  let responseBody;
  try {
    responseBody = await providerResponse.json();
  } catch {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
  }

  // Cloudflare /ai/run wraps payloads in {result, success, errors}; callers
  // expect the System One body shape ({model, answers, usage}) at top level.
  if (modelInUrl && responseBody?.success === false) {
    const detail = responseBody?.errors?.[0]?.message || "Upstream returned success:false";
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `${provider}: ${detail}`);
  }
  if (modelInUrl && responseBody?.result && typeof responseBody.result === "object") {
    responseBody = responseBody.result;
  }

  if (onRequestSuccess) await onRequestSuccess();

  const usage = responseBody?.usage;
  return {
    success: true,
    usage: usage
      ? { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0 }
      : null,
    response: new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
