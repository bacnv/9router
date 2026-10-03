import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";

const CF_URL = "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/cloudflare/clef";

function stubFetch(payload, ok = true, status = 200) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => payload,
    };
  });
  return calls;
}

const baseArgs = {
  body: { state: "customer charged twice", questions: { q: { type: "noul", instructions: "urgent?" } } },
  modelInfo: { provider: "cloudflare-ai", model: "@cf/cloudflare/clef" },
  credentials: { apiKey: "cf-token", providerSpecificData: { accountId: "acct-1" } },
  log: { debug: () => {} },
};

describe("cloudflare Clef via systemoneCore", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("substitutes {accountId}/{model} into the URL and drops model from the body", async () => {
    const calls = stubFetch({ result: { model: "clef", answers: { q: { noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 1 } } });
    const res = await handleSystemoneCore({ ...baseArgs });

    expect(res.success).toBe(true);
    expect(calls[0].url).toBe(CF_URL);
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.model).toBeUndefined();
    expect(sent.state).toBe("customer charged twice");
    expect(calls[0].init.headers.Authorization).toBe("Bearer cf-token");
  });

  it("unwraps the {result} envelope and maps usage", async () => {
    stubFetch({ result: { model: "clef", answers: { q: { noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 1 } } });
    const res = await handleSystemoneCore({ ...baseArgs });
    const out = await res.response.json();

    expect(out.answers.q.noul).toBe(0.9);
    expect(out.result).toBeUndefined();
    expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 1 });
  });

  it("surfaces {success:false} envelopes as errors instead of a fake success", async () => {
    stubFetch({ result: null, success: false, errors: [{ code: 7003, message: "no such model" }] });
    const res = await handleSystemoneCore({ ...baseArgs });

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("no such model");
  });

  it("requires accountId when the baseUrl needs it", async () => {
    const res = await handleSystemoneCore({ ...baseArgs, credentials: { apiKey: "t" } });
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("accountId");
  });

  it("keeps model in the body for body-style lanes (opencode-zen)", async () => {
    const calls = stubFetch({ model: "jev-1.13", answers: { q: { noul: 0.5 } } });
    await handleSystemoneCore({
      ...baseArgs,
      modelInfo: { provider: "opencode-zen", model: "jev-1.13" },
      credentials: { apiKey: "zen" },
    });
    expect(calls[0].url).toBe("https://opencode.ai/zen/v1/systemone");
    expect(JSON.parse(calls[0].init.body).model).toBe("jev-1.13");
  });
});
