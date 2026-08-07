import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  configureQuotaAutoPing: vi.fn(),
  json: vi.fn((body, init) => ({ body, status: init?.status || 200 })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(),
    genSalt: vi.fn(),
    hash: vi.fn(),
  },
}));

// The route dynamic-imports quotaAutoPing; the mock factory must return a
// configureQuotaAutoPing spy so we can assert the wiring.
vi.mock("@/shared/services/quotaAutoPing", () => ({
  configureQuotaAutoPing: mocks.configureQuotaAutoPing,
}));

describe("settings route auto-ping wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
  });

  it("invokes configureQuotaAutoPing when PATCH includes ollamaAutoPing", async () => {
    const settings = { ollamaAutoPing: { connections: { "ollama-1": true } } };
    mocks.updateSettings.mockResolvedValue(settings);

    const { PATCH } = await import("../../src/app/api/settings/route.js");
    await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ollamaAutoPing: { connections: { "ollama-1": true } } }),
    }));

    // Dynamic import is async; give it a microtask to resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.updateSettings).toHaveBeenCalledWith({ ollamaAutoPing: { connections: { "ollama-1": true } } });
    expect(mocks.configureQuotaAutoPing).toHaveBeenCalledTimes(1);
    expect(mocks.configureQuotaAutoPing).toHaveBeenCalledWith(settings);
  });

  it("does not invoke configureQuotaAutoPing when PATCH lacks auto-ping keys", async () => {
    mocks.updateSettings.mockResolvedValue({ providerStrategies: {} });

    const { PATCH } = await import("../../src/app/api/settings/route.js");
    await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerStrategies: {} }),
    }));

    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.configureQuotaAutoPing).not.toHaveBeenCalled();
  });
});
