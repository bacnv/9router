import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const { getCharmUsage } = await import("../../open-sse/services/usage/misc.js");

describe("Charm usage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the available credit balance", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ balance: 75 }),
    });

    const result = await getCharmUsage("fixture-credential");

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://hyper.charm.land/v1/credits",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fixture-credential" }),
      }),
      null,
    );
    // Credit-balance shape: `total` carries the balance itself, and
    // isCreditBalance tells QuotaTable to render currency, not a percentage bar.
    expect(result).toEqual({
      plan: "Charm",
      quotas: {
        "Balance (Hypercredits)": {
          used: 0,
          total: 75,
          remaining: 75,
          remainingPercentage: 100,
          resetAt: null,
          isCreditBalance: true,
          currency: "Hypercredits",
        },
      },
    });
  });

  it("reports an empty balance as a spent credit, not a full one", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ balance: 0 }),
    });

    const result = await getCharmUsage("fixture-credential");
    expect(result.quotas["Balance (Hypercredits)"]).toMatchObject({
      total: 0,
      remainingPercentage: 0,
      isCreditBalance: true,
    });
  });

  it("rejects an invalid balance", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ balance: "invalid" }),
    });

    expect(await getCharmUsage("fixture-credential")).toEqual({
      message: "Charm credits response did not contain a valid balance.",
    });
  });
});
