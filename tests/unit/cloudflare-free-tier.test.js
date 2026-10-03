import { describe, expect, it, beforeEach } from "vitest";
import {
  dailyNeurons, getExhaustedConnections, isExhausted, neuronsFromCost,
  utcDayStart, nextUtcReset, clearCloudflareUsageCache,
  FREE_NEURONS_PER_DAY, NEURON_USD,
} from "@/lib/cloudflareFreeTier.js";

// In-memory stand-in for the sqlite adapter. The real query filters by
// connectionId, so the fake keys its answer the same way — that keeps the test
// independent of the order connections are visited in.
function fakeAdapter(costByConnection = {}) {
  const calls = [];
  return {
    calls,
    get(sql, params) {
      calls.push({ sql, params });
      const [connectionId, since] = params;
      expect(sql).toContain("usageHistory");
      expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/); // UTC day start
      return { cost: costByConnection[connectionId] ?? 0 };
    },
  };
}

const conn = (id) => ({ id });

beforeEach(() => clearCloudflareUsageCache());

describe("cloudflare free-tier neuron guard", () => {
  it("converts billed cost back to neurons at the published rate", () => {
    expect(NEURON_USD).toBeCloseTo(0.000011, 12);
    // $0.11 is exactly the 10,000-neuron daily allowance
    expect(neuronsFromCost(0.11)).toBeCloseTo(10_000, 6);
    // a single clef-flash call: 420 input tokens @ $0.09/M
    expect(neuronsFromCost(420 * 0.09 / 1e6)).toBeCloseTo(3.44, 1);
  });

  it("treats a missing or negative cost as zero neurons", () => {
    expect(neuronsFromCost(undefined)).toBe(0);
    expect(neuronsFromCost(null)).toBe(0);
    expect(neuronsFromCost(-1)).toBe(0);
    expect(neuronsFromCost("nonsense")).toBe(0);
  });

  it("resets at 00:00 UTC, not local midnight", () => {
    // 23:59 UTC and 00:01 UTC must land in different buckets
    const before = utcDayStart(Date.parse("2026-10-03T23:59:00Z"));
    const after = utcDayStart(Date.parse("2026-10-04T00:01:00Z"));
    expect(before).toBe("2026-10-03T00:00:00.000Z");
    expect(after).toBe("2026-10-04T00:00:00.000Z");
    expect(nextUtcReset(Date.parse("2026-10-03T23:59:00Z"))).toBe("2026-10-04T00:00:00.000Z");
  });

  it("counts only this connection's cloudflare spend since the UTC day start", async () => {
    const deps = { getAdapter: async () => fakeAdapter({ "conn-1": 0.05 }), getSettings: async () => ({}) };
    const used = await dailyNeurons("conn-1", deps);
    expect(used).toBeCloseTo(4545.45, 1);
  });

  it("marks a connection exhausted only once the allocation is fully spent", () => {
    expect(isExhausted(9_999)).toBe(false);
    expect(isExhausted(FREE_NEURONS_PER_DAY)).toBe(true);
    expect(isExhausted(10_001)).toBe(true);
  });

  it("does nothing at all while the cap is off (default)", async () => {
    const adapter = fakeAdapter({ a: 1.0, b: 1.0 }); // both far over the cap
    const deps = { getAdapter: async () => adapter, getSettings: async () => ({ cloudflareFreeOnly: false }) };
    const exhausted = await getExhaustedConnections([conn("a"), conn("b")], deps);
    expect(exhausted.size).toBe(0);
    expect(adapter.calls).toHaveLength(0); // no query ran
  });

  it("blocks only the connections that went over, once enabled", async () => {
    // $0.15 -> 13,636 neurons (over) ; $0.02 -> 1,818 (under)
    const deps = { getAdapter: async () => fakeAdapter({ over: 0.15, under: 0.02 }), getSettings: async () => ({ cloudflareFreeOnly: true }) };
    const exhausted = await getExhaustedConnections([conn("over"), conn("under")], deps);
    expect([...exhausted]).toEqual(["over"]);
  });

  it("caches reads briefly so a burst does not hammer sqlite", async () => {
    const adapter = fakeAdapter({ x: 0.05 });
    const deps = { getAdapter: async () => adapter, getSettings: async () => ({ cloudflareFreeOnly: true }) };
    await getExhaustedConnections([conn("x")], deps);
    await getExhaustedConnections([conn("x")], deps);
    expect(adapter.calls).toHaveLength(1);
  });
});
