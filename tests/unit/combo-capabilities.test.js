import { describe, expect, it, vi } from "vitest";
import { getComboCapabilities, handleComboChat } from "../../open-sse/services/combo.js";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => [{
    name: "gpt-5.6-sol",
    models: ["codex/gpt-5.6-sol", "codex/gpt-5.5-codex"],
  }]),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));

describe("getComboCapabilities", () => {
  it("advertises only shared tool support", () => {
    expect(getComboCapabilities([
      "codex/gpt-5.6-sol",
      "codex/gpt-5.5-codex",
    ])).toEqual({ tools: true });
  });

  it("does not advertise a capability missing from a fallback member", () => {
    expect(getComboCapabilities([
      "codex/gpt-5.6-sol",
      "codex/gpt-image-1",
    ]).tools).toBe(false);
  });

  it("adds aggregate capabilities to combo catalog entries", async () => {
    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const models = await buildModelsList(["llm"]);

    const combo = models.find((model) => model.id === "gpt-5.6-sol");
    expect(combo).toMatchObject({
      owned_by: "combo",
      capabilities: { tools: true },
    });
    expect(combo.capabilities).toEqual({ tools: true });
  });

  it("tries intermediate members and stops at the first success", async () => {
    const attempted = [];
    const response = await handleComboChat({
      body: {},
      models: ["a/one", "b/two", "c/three"],
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        return Response.json(
          model === "b/two" ? { ok: true } : { error: { message: "rate limited" } },
          { status: model === "b/two" ? 200 : 429 },
        );
      },
      log: { info() {}, warn() {} },
      comboName: "test",
      comboStrategy: "fallback",
    });

    expect(response.ok).toBe(true);
    expect(attempted).toEqual(["a/one", "b/two"]);
  });
});
