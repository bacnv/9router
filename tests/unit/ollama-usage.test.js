import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

// The per-model breakdown is counted from usageHistory, so the sqlite adapter
// is stubbed — default empty so unrelated cases need not care.
const dbAll = vi.fn(() => []);
vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({ all: dbAll, get: vi.fn(), run: vi.fn(), transaction: (f) => f() })),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// ollama.com/api/usage used to report `limits.<window>.usage` ratios and this
// file asserted the percentage bars built from them. Ollama removed that field;
// the live response is now {range, granularity, totals:{request_count}, buckets}
// and carries no ceiling at all — verified against the account on 2026-10-07 by
// probing every plausible limits/quota path (/api/limits, /api/quota,
// /api/usage/limits, /api/plan, /api/billing, scope=all …), all 404 or 400.
// The handler therefore reports the count as an unlimited row rather than
// inventing a denominator.

const USAGE_URL = "https://ollama.com/api/usage?range=30d";
const ME_URL = "https://ollama.com/api/me";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Shape captured verbatim from a live /api/usage?range=30d call.
const SAMPLE_USAGE = {
  range: "30d",
  scope: "self",
  granularity: "day",
  from: "2026-09-07T00:00:00Z",
  until: "2026-10-07T04:43:58Z",
  totals: { request_count: 39204 },
  buckets: [
    { from: "2026-09-07T00:00:00Z", until: "2026-09-08T00:00:00Z", request_count: 415 },
    { from: "2026-09-08T00:00:00Z", until: "2026-09-09T00:00:00Z", request_count: 502 },
  ],
};

const SAMPLE_ME = { Plan: "max", CreatedAt: "2026-05-29T05:29:12.495696Z" };

describe("ollama registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("ollama");
    expect(USAGE_APIKEY_PROVIDERS).toContain("ollama");
  });

  it("exposes GLM 5.3 Flash with vision and thinking", () => {
    expect(PROVIDER_MODELS.ollama.some((model) => model.id === "glm-5.3-flash")).toBe(true);
    expect(getCapabilitiesForModel("ollama", "glm-5.3-flash")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "zai",
    });
  });
});

describe("getUsageForProvider(ollama)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbAll.mockReturnValue([]);
  });

  it("GETs /api/usage?range=30d with Bearer apiKey and POSTs /api/me for plan", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_USAGE))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ME));

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Max");
    expect(usage.quotas["Monthly"]).toMatchObject({
      used: 39204,
      total: 0,
      unlimited: true,
    });
    // No ceiling exists upstream, so nothing may be fabricated as a ratio.
    expect(usage.quotas["Monthly"].remainingPercentage).toBeUndefined();
    expect(usage.quotas["Monthly"].remaining).toBeUndefined();

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);

    const [usageUrl, usageOpts] = proxyAwareFetch.mock.calls[0];
    expect(usageUrl).toBe(USAGE_URL);
    expect(usageOpts.headers.Authorization).toBe("Bearer k");
    expect(usageOpts.headers.Accept).toBe("application/json");

    const [meUrl, meOpts] = proxyAwareFetch.mock.calls[1];
    expect(meUrl).toBe(ME_URL);
    expect(meOpts.method).toBe("POST");
    expect(meOpts.headers.Authorization).toBe("Bearer k");
    expect(meOpts.headers["Content-Length"]).toBe("0");
  });

  it("breaks the window down by model, busiest first", async () => {
    dbAll.mockReturnValueOnce([
      { model: "deepseek-v4.1-flash", n: 37863 },
      { model: "glm-5.3-flash", n: 234 },
      { model: "kimi-k2.7-code", n: 8 },
    ]);
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_USAGE))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ME));

    const usage = await getUsageForProvider({
      provider: "ollama", apiKey: "k", id: "conn-1",
    });

    expect(usage.quotas["Monthly"].models).toEqual([
      { name: "deepseek-v4.1-flash", requestCount: 37863 },
      { name: "glm-5.3-flash", requestCount: 234 },
      { name: "kimi-k2.7-code", requestCount: 8 },
    ]);
    // Counted per connection and scoped to the API window.
    const [sql, params] = dbAll.mock.calls[0];
    expect(sql).toContain("usageHistory");
    expect(params[0]).toBe("conn-1");
    expect(params[1]).toBe(SAMPLE_USAGE.from);
  });

  it("degrades to an empty breakdown when the ledger is unreadable", async () => {
    dbAll.mockImplementationOnce(() => { throw new Error("no db"); });
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_USAGE))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ME));

    const usage = await getUsageForProvider({
      provider: "ollama", apiKey: "k", id: "conn-1",
    });

    // The headline count from the API must survive a missing breakdown.
    expect(usage.quotas["Monthly"].used).toBe(39204);
    expect(usage.quotas["Monthly"].models).toEqual([]);
  });

  it("reports an empty breakdown when no connection id is available", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_USAGE))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ME));

    const usage = await getUsageForProvider({ provider: "ollama", apiKey: "k" });

    expect(usage.quotas["Monthly"].models).toEqual([]);
    expect(dbAll).not.toHaveBeenCalled();
  });

  it("labels the window from the range the API reports", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({
        range: "24h",
        granularity: "hour",
        from: "2026-10-06T04:00:00Z",
        totals: { request_count: 2126 },
        buckets: [{ from: "2026-10-06T04:00:00Z", until: "2026-10-06T05:00:00Z", request_count: 89 }],
      }))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ME));

    const usage = await getUsageForProvider({ provider: "ollama", apiKey: "k" });

    expect(Object.keys(usage.quotas)).toEqual(["Session (5h)"]);
    expect(usage.quotas["Session (5h)"].used).toBe(2126);
  });

  describe("monthly reset from signup date", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function monthlyResetAt(createdAt, now, plan = "free") {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      proxyAwareFetch
        .mockResolvedValueOnce(jsonResponse(SAMPLE_USAGE))
        .mockResolvedValueOnce(jsonResponse({ Plan: plan, CreatedAt: createdAt }));

      const usage = await getUsageForProvider({ provider: "ollama", apiKey: "k" });
      return usage.quotas["Monthly"].resetAt;
    }

    it("uses the signup day of the next month", async () => {
      expect(await monthlyResetAt("2025-09-06T22:15:39.871687Z", "2026-09-18T15:03:00Z"))
        .toBe("2026-10-06T22:15:39.000Z");
    });

    it("stays in the current month when the signup day is still ahead", async () => {
      expect(await monthlyResetAt("2026-09-18T09:50:49.514335Z", "2026-09-18T15:33:33Z"))
        .toBe("2026-10-18T09:50:49.000Z");
      expect(await monthlyResetAt("2025-09-25T10:00:00Z", "2026-09-18T15:33:33Z"))
        .toBe("2026-09-25T10:00:00.000Z");
    });

    it("clamps the signup day to shorter months", async () => {
      expect(await monthlyResetAt("2026-01-31T12:00:00Z", "2026-02-10T00:00:00Z"))
        .toBe("2026-02-28T12:00:00.000Z");
    });

    it("applies to paid plans too — the allowance resets on the same anniversary", async () => {
      // Pro/Max meter in credits against a monthly allowance that resets on the
      // subscription date, so the derived reset is still the right thing to show.
      expect(await monthlyResetAt("2026-05-29T05:29:12.495696Z", "2026-10-07T04:43:00Z", "pro"))
        .toBe("2026-10-29T05:29:12.000Z");
    });

    it("omits the reset when the signup date is unusable", async () => {
      expect(await monthlyResetAt(undefined, "2026-09-18T15:03:00Z")).toBeNull();
    });
  });

  it("reports no limits when the response carries no totals", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ range: "30d", granularity: "day", buckets: [] }))
      .mockResolvedValueOnce(jsonResponse({ Plan: "free" }));

    const usage = await getUsageForProvider({ provider: "ollama", apiKey: "k" });

    expect(usage.message).toMatch(/no usage limits/i);
    expect(usage.quotas).toEqual({});
  });

  it("surfaces invalid key message on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ error: "unauthorized" }, 401),
    );

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "bad",
    });

    expect(usage.message).toMatch(/invalid/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("returns message when apiKey missing", async () => {
    const usage = await getUsageForProvider({
      provider: "ollama",
      providerSpecificData: {},
    });

    expect(usage.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("Ollama quota count UI", () => {
  it("renders bucket counts horizontally with wrapping separators", () => {
    const source = readFileSync(
      new URL("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js", import.meta.url),
      "utf8",
    );

    expect(source).toContain("quota.models.map");
    expect(source).toContain("flex-wrap");
    expect(source).toContain("model.name");
    expect(source).toContain("model.requestCount");
  });
});

describe("parseQuotaData(ollama)", () => {
  it("carries the unlimited flag through so the table shows a count, not a bar", () => {
    const rows = parseQuotaData("ollama", {
      plan: "Pro",
      quotas: {
        Monthly: {
          used: 39204,
          total: 0,
          resetAt: "2026-10-29T05:29:12.000Z",
          unlimited: true,
          models: [{ name: "9/7", requestCount: 415 }],
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Monthly",
      used: 39204,
      unlimited: true,
    });
    expect(rows[0].models).toEqual([{ name: "9/7", requestCount: 415 }]);
  });
});
