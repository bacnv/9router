import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getUsageForProvider: vi.fn(),
  getExecutor: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: mocks.getExecutor,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

describe("xAI usage route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local",
    });
  });

  it("rejects xAI API-key usage before resolving proxy or calling billing", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "xai-key",
      provider: "xai",
      authType: "apikey",
      apiKey: "secret",
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/xai-key"), {
      params: Promise.resolve({ connectionId: "xai-key" }),
    });

    expect(await response.json()).toEqual({
      message: "Usage not available for this connection",
    });
    expect(mocks.resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
  });

  it("force-refreshes xAI OAuth once and retries usage with the new token", async () => {
    const connection = {
      id: "xai-oauth",
      provider: "xai",
      authType: "oauth",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      providerSpecificData: {},
    };
    const refreshedConnection = { ...connection, accessToken: "new-token" };
    const executor = {
      needsRefresh: vi.fn().mockReturnValue(false),
      refreshCredentials: vi.fn().mockResolvedValue({
        accessToken: "new-token",
        refreshToken: "refresh-token",
        expiresIn: 3600,
      }),
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.getExecutor.mockReturnValue(executor);
    mocks.getUsageForProvider
      .mockResolvedValueOnce({ message: "xAI authentication expired. Please re-authorize." })
      .mockResolvedValueOnce({
        plan: "XPremiumPlus",
        quotas: { Weekly: { used: 34, total: 100, remainingPercentage: 66 } },
      });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/xai-oauth"), {
      params: Promise.resolve({ connectionId: "xai-oauth" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).quotas.Weekly.used).toBe(34);
    expect(executor.refreshCredentials).toHaveBeenCalledTimes(1);
    expect(executor.refreshCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "refresh-token" }),
      console,
      expect.objectContaining({
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.local",
        strictProxy: false,
      }),
    );
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "xai-oauth",
      expect.objectContaining({ accessToken: "new-token" }),
    );
    expect(mocks.getUsageForProvider).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining(refreshedConnection),
      expect.objectContaining({ strictProxy: false }),
    );
  });
});
