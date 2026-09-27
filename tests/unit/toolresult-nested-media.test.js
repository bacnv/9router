import { describe, it, expect } from "vitest";
import { detectRequiredCapabilities } from "../../open-sse/services/combo.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// A tool returning an image (Claude's Read on a screenshot) nests the block
// inside tool_result.content. Both the capability scan and the stripper must
// look there too, or a text-only combo member receives a data URI it rejects.
const NESTED_IMG = { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } };
const TOOL_RESULT = (content) => ({ type: "tool_result", tool_use_id: "t1", content });

describe("detectRequiredCapabilities: nested tool_result media", () => {
  it("claude tool_result with image -> vision", () => {
    const r = detectRequiredCapabilities({ messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [TOOL_RESULT([{ type: "text", text: "read" }, NESTED_IMG])] },
    ] });
    expect(r.has("vision")).toBe(true);
  });

  it("claude tool_result with document -> pdf", () => {
    const r = detectRequiredCapabilities({ messages: [
      { role: "user", content: [TOOL_RESULT([
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x" } },
      ])] },
    ] });
    expect(r.has("pdf")).toBe(true);
  });

  it("tool_result with only text -> no caps", () => {
    const r = detectRequiredCapabilities({ messages: [
      { role: "user", content: [TOOL_RESULT([{ type: "text", text: "ok" }])] },
    ] });
    expect(r.size).toBe(0);
  });

  it("media in history is not scanned, nested or not", () => {
    const r = detectRequiredCapabilities({ messages: [
      { role: "user", content: [TOOL_RESULT([NESTED_IMG])] },
      { role: "assistant", content: "done" },
      { role: "user", content: "and now?" },
    ] });
    expect(r.size).toBe(0);
  });

  it("responses function_call_output output is flattened upstream, so no cap", () => {
    // responsesApi.coerceResponsesOutput stringifies non-text parts before send.
    const r = detectRequiredCapabilities({ input: [
      { type: "function_call_output", call_id: "c1", output: [
        { type: "input_image", image_url: "data:image/png;base64,x" },
      ] },
    ] });
    expect(r.size).toBe(0);
  });
});

describe("stripUnsupportedModalities: nested tool_result media", () => {
  it("claude: strips image nested in tool_result, keeps tool_result + placeholder", () => {
    const body = { messages: [
      { role: "user", content: [
        { type: "text", text: "see" },
        TOOL_RESULT([{ type: "text", text: "read" }, NESTED_IMG]),
      ] },
    ] };
    stripUnsupportedModalities(body, FORMATS.CLAUDE, { vision: false, audioInput: true, pdf: true });
    const msg = body.messages[0];
    const tr = msg.content.find((b) => b.type === "tool_result");
    expect(tr).toBeTruthy();
    expect(tr.content.some((c) => c.type === "image")).toBe(false);
    expect(tr.content.some((c) => c.type === "text" && /image omitted/.test(c.text))).toBe(true);
    // Exactly one placeholder: inside the tool_result, not duplicated at the top.
    expect(msg.content.filter((b) => b.type === "text" && /image omitted/.test(b.text))).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain("base64");
  });

  it("claude: leaves nested image alone when model has vision", () => {
    const body = { messages: [{ role: "user", content: [TOOL_RESULT([NESTED_IMG])] }] };
    stripUnsupportedModalities(body, FORMATS.CLAUDE, { vision: true, audioInput: true, pdf: true });
    expect(JSON.stringify(body)).toContain("base64");
  });

  it("openai: strips image nested in tool_result content", () => {
    const body = { messages: [
      { role: "assistant", content: [{ type: "text", text: "calling" }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
        ] },
      ] },
    ] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, { vision: false, audioInput: true, pdf: true });
    const tr = body.messages[1].content.find((b) => b.type === "tool_result");
    expect(tr.content.some((c) => c.type === "image_url")).toBe(false);
  });
});

describe("end to end: what the upstream actually receives", () => {
  const claudeBody = () => ({ model: "m", stream: true, max_tokens: 16, messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { role: "user", content: [TOOL_RESULT([{ type: "text", text: "read" }, NESTED_IMG])] },
  ] });

  it("text-only member: no image data URI survives to the upstream payload", () => {
    const body = claudeBody();
    stripUnsupportedModalities(body, FORMATS.CLAUDE, { vision: false, audioInput: true, pdf: true });
    const payload = JSON.stringify(claudeToOpenAIRequest("m", body, true));
    expect(payload).not.toContain("data:image/");
    expect(payload).toContain("image omitted");
  });

  it("vision member: image still reaches the upstream payload", () => {
    const payload = JSON.stringify(claudeToOpenAIRequest("m", claudeBody(), true));
    expect(payload).toContain("data:image/png;base64,x");
  });

  it("later text-only turn: history image is placeholdered, not shipped", () => {
    // The production failure: the image lives in history, the new question is
    // text-only, so caps is empty and the combo picks a text-only member again.
    const body = { model: "m", stream: true, max_tokens: 16, messages: [
      ...claudeBody().messages,
      { role: "assistant", content: "đã xem" },
      { role: "user", content: "còn gì nữa?" },
    ] };
    stripUnsupportedModalities(body, FORMATS.CLAUDE, { vision: false, audioInput: true, pdf: true });
    const payload = JSON.stringify(claudeToOpenAIRequest("m", body, true));
    expect(payload).not.toContain("data:image/");
    expect(payload).toContain("Previous image omitted from context.");
  });
});
