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
    expect(result).toEqual({
      plan: "Charm",
      quotas: {
        "Monthly Hypercredits": {
          used: 25,
          total: 100,
          remaining: 75,
          remainingPercentage: 75,
          resetAt: null,
        },
      },
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
