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

  it("returns a billing error when both billing endpoints fail without auth errors", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "bad gateway" }, 502))
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(USER));

    const usage = await getUsageForProvider({ provider: "xai", accessToken: "token" });
    expect(usage.message).toMatch(/billing API error.*502.*503/i);
  });
});
