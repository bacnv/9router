import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CREDITS = {
  config: {
    currentPeriod: { end: "2026-07-22T00:00:00Z" },
    productUsage: [{ product: "Api", usagePercent: 34 }],
  },
};

const MONTHLY = {
  config: {
    monthlyLimit: { val: 15000 },
    used: { val: 874 },
    billingPeriodEnd: "2026-08-01T00:00:00Z",
  },
};

const USER = {
  userId: "user-1",
  email: "user@example.com",
  hasGrokCodeAccess: true,
  subscriptionTier: "XPremiumPlus",
};

describe("xai OAuth usage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is exposed by the registry with all billing URLs", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("xai");
    expect(PROVIDERS.xai.usage).toMatchObject({
      url: expect.stringContaining("format=credits"),
      monthlyUrl: expect.stringMatching(/\/v1\/billing$/),
      userUrl: expect.stringContaining("include=subscription"),
    });
  });

  it("returns combined weekly and monthly quotas", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(CREDITS))
      .mockResolvedValueOnce(jsonResponse(MONTHLY))
      .mockResolvedValueOnce(jsonResponse(USER));

    const proxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local",
      strictProxy: false,
    };
    const usage = await getUsageForProvider({
      provider: "xai",
      accessToken: "xai-token",
      providerSpecificData: { userId: "user-1", email: "user@example.com" },
    }, proxyOptions);

    expect(usage.quotas.Weekly).toMatchObject({ used: 34, total: 100 });
    expect(usage.quotas.Monthly).toMatchObject({ used: 874, total: 15000 });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    for (const call of proxyAwareFetch.mock.calls) {
      expect(call[1].headers.Authorization).toBe("Bearer xai-token");
      expect(call[2]).toBe(proxyOptions);
    }
  });

  it("uses monthly quota when credits fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(MONTHLY))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.message).toBeUndefined();
    expect(usage.quotas.Monthly).toMatchObject({ used: 874, total: 15000 });
  });

  it("uses weekly quota when monthly fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(CREDITS))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockRejectedValueOnce(new Error("user endpoint down"));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.message).toBeUndefined();
    expect(usage.quotas.Weekly).toMatchObject({ used: 34, total: 100 });
  });

  it("returns auth-expired only when no billing endpoint succeeds", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "expired" });
    expect(usage.message).toMatch(/expired|re-authorize/i);
  });

  it("treats empty billing JSON as unusable so a mixed 401 refreshes", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "expired" });
    expect(usage.message).toMatch(/expired|re-authorize/i);
  });

  it("bounds every upstream request with an abort signal", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(CREDITS))
      .mockResolvedValueOnce(jsonResponse(MONTHLY))
      .mockResolvedValueOnce(jsonResponse(USER));

    await getUsageForProvider({ provider: "xai", accessToken: "token" });
    for (const [, options] of proxyAwareFetch.mock.calls) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("forwards top-level xAI email identity", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(CREDITS))
      .mockResolvedValueOnce(jsonResponse(MONTHLY))
      .mockResolvedValueOnce(jsonResponse(USER));

    await getUsageForProvider({
      provider: "xai",
      accessToken: "token",
      email: "top-level@example.com",
      providerSpecificData: {},
    });
    expect(proxyAwareFetch.mock.calls[0][1].headers["x-email"]).toBe("top-level@example.com");
  });
});

describe("xai OAuth refresh", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refreshes through proxyAwareFetch and preserves an unrotated refresh token", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      access_token: "new-access-token",
      expires_in: 3600,
    }));
    const proxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local",
      strictProxy: false,
    };

    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const result = await new DefaultExecutor("xai").refreshCredentials(
      { refreshToken: "old-refresh-token" },
      null,
      proxyOptions,
    );

    expect(result).toEqual({
      accessToken: "new-access-token",
      refreshToken: "old-refresh-token",
      expiresIn: 3600,
    });
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://auth.x.ai/oauth2/token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(URLSearchParams),
      }),
      proxyOptions,
    );
    const body = proxyAwareFetch.mock.calls[0][1].body;
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh-token",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    });
  });

  it("rejects a successful refresh response without access_token", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ expires_in: 3600 }));
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const result = await new DefaultExecutor("xai").refreshCredentials({
      refreshToken: "old-refresh-token",
    });
    expect(result).toBeNull();
  });
});

describe("xai OAuth usage extended", () => {
  it("returns a billing error when both billing endpoints fail without auth errors", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "bad gateway" }, 502))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.message).toMatch(/billing API error.*502.*503/i);
  });

  it("uses monthly when credits returns 200 invalid JSON", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(jsonResponse(MONTHLY))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.message).toBeUndefined();
    expect(usage.quotas.Monthly).toMatchObject({ used: 874, total: 15000 });
    expect(usage.quotas.Weekly).toBeUndefined();
  });

  it("rejects invalid JSON when no billing body is parseable", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.message).toMatch(/billing response was not JSON/i);
    expect(usage.message).not.toMatch(/active.*numeric included quota/i);
  });

  it("merges all quota types from a monthly-only payload", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ config: {
        monthlyLimit: { val: 1000 },
        includedUsed: { val: 250 },
        onDemandCap: { val: 100 },
        onDemandUsed: { val: 25 },
        prepaidBalance: { val: 10 },
        credits: { total: 50, used: 5 },
      } }))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.quotas).toMatchObject({
      Monthly: { used: 250, total: 1000 },
      "On-demand": { used: 25, total: 100 },
      Prepaid: { used: 0, total: 10 },
      Credits: { used: 5, total: 50 },
    });
  });

  it("always emits aggregate Weekly alongside non-API product rows", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ config: {
        productUsage: [{ product: "Grok", usagePercent: 20 }],
        creditUsagePercent: 40,
      } }))
      .mockResolvedValueOnce(jsonResponse(MONTHLY))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.quotas.Grok).toMatchObject({ used: 20, total: 100 });
    expect(usage.quotas.Weekly).toMatchObject({ used: 40, total: 100 });
  });

  it("encodes exhausted remaining-only Credits for generic dashboard parsing", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ config: { credits: { remaining: 0 } } }))
      .mockResolvedValueOnce(jsonResponse(MONTHLY))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.quotas.Credits).toMatchObject({
      used: 1,
      total: 1,
      remainingPercentage: 0,
    });
  });

  it("cancels failed response bodies when usable billing exists", async () => {
    const failed = jsonResponse({ error: "unavailable" }, 503);
    const cancel = vi.spyOn(failed.body, "cancel");
    proxyAwareFetch
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(jsonResponse(MONTHLY))
      .mockResolvedValueOnce(jsonResponse(USER));

    await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
