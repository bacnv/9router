import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const CUSTOM = "anthropic-compatible-90582bb0-1c5e-446e-98aa-2bfe73faa6d2";

// A Claude CLI body: claude-image block, so the strip and the passthrough both apply.
const claudeBody = () => ({
  model: "deepseek-v4-flash",
  system: "be terse",
  max_tokens: 32,
  stream: false,
  messages: [
    { role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ] },
  ],
});

async function run({ provider, model, headers, body }) {
  await handleChatCore({
    body,
    modelInfo: { provider, model },
    credentials: { accessToken: "t", providerSpecificData: {}, connectionName: "c" },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "conn",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    clientRawRequest: { endpoint: "/v1/messages", body, headers },
  });
  return executeMock.mock.calls.at(-1)[0].body;
}

const CLAUDE_CLI = { "user-agent": "claude-cli/2.1.283", "x-app": "cli", accept: "application/json" };

describe("passthrough to a hand-added node still strips unreadable media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response("", { status: 200 }),
      url: "https://gen-dev-api.fci.vn:8443/anthropic/v1/messages",
      headers: {},
      transformedBody: null,
    });
  });

  it("custom node + claude CLI: image does not reach the upstream", async () => {
    const sent = await run({ provider: CUSTOM, model: "deepseek-v4-flash", headers: CLAUDE_CLI, body: claudeBody() });
    expect(JSON.stringify(sent)).not.toContain("base64");
    expect(JSON.stringify(sent)).toContain("image omitted");
  });

  it("custom node + claude CLI: a model that reads images keeps them", async () => {
    const sent = await run({ provider: CUSTOM, model: "claude-sonnet-5", headers: CLAUDE_CLI, body: claudeBody() });
    expect(JSON.stringify(sent)).toContain("base64");
  });

  it("custom node + claude CLI: a document survives (table says pdf false, endpoint reads them)", async () => {
    const body = claudeBody();
    body.messages[0].content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "PDFDATA" } },
    ];
    const sent = await run({ provider: CUSTOM, model: "claude-sonnet-5", headers: CLAUDE_CLI, body });
    expect(JSON.stringify(sent)).toContain("PDFDATA");
  });

  it("registry claude + claude CLI: untouched, as before", async () => {
    const sent = await run({ provider: "claude", model: "claude-sonnet-5", headers: CLAUDE_CLI, body: claudeBody() });
    expect(JSON.stringify(sent)).toContain("base64");
  });

  it("native codex passthrough is not stripped even though its table says vision false", async () => {
    const body = {
      model: "gpt-5-codex",
      input: [{ role: "user", content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ] }],
      stream: false,
    };
    const sent = await run({
      provider: "codex",
      model: "gpt-5-codex",
      headers: { "user-agent": "codex-cli/0.144.1", accept: "application/json" },
      body,
    });
    expect(JSON.stringify(sent)).toContain("data:image/png;base64,AAAA");
  });
});

describe("strip does not leak across combo members sharing one body", () => {
  const IMG = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };
  const NO_VISION = { vision: false, audioInput: true, pdf: true };

  it("a text-only member's strip leaves the source body intact for the next member", () => {
    const msg = { role: "user", content: [{ type: "text", text: "xem" }, IMG] };
    const outer = { messages: [msg] };

    // Same shallow per-member copy the combo dispatcher makes (src/sse/handlers/chat.js).
    const member1 = { ...outer, model: "deepseek-v4-flash" };
    stripUnsupportedModalities(member1, FORMATS.CLAUDE, NO_VISION);

    expect(JSON.stringify(member1)).not.toContain("base64");
    expect(JSON.stringify(outer)).toContain("base64");
    expect(msg.content).toHaveLength(2);
  });

  it("does not rewrite nested tool_result blocks in place", () => {
    const nested = { type: "tool_result", tool_use_id: "t", content: [IMG] };
    const body = { messages: [{ role: "user", content: [nested] }] };
    stripUnsupportedModalities(body, FORMATS.CLAUDE, NO_VISION);
    expect(nested.content).toHaveLength(1);
    expect(nested.content[0].type).toBe("image");
  });

  it("openai member does not rewrite the shared message object", () => {
    const msg = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] };
    const outer = { messages: [msg] };
    stripUnsupportedModalities({ ...outer, model: "m" }, FORMATS.OPENAI, NO_VISION);
    expect(msg.content[0].type).toBe("image_url");
  });

  it("gemini member does not rewrite shared contents", () => {
    const c = { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AAA" } }] };
    const outer = { contents: [c] };
    stripUnsupportedModalities({ ...outer, model: "m" }, FORMATS.GEMINI, NO_VISION);
    expect(c.parts[0].inlineData).toBeTruthy();
    expect(outer.contents).toHaveLength(1);
  });
});
