import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import {
  collectOptionalToolFields,
  removeNullOptionalToolFields,
} from "../../open-sse/translator/concerns/optionalToolFields.js";

function transformCodexTools(tools) {
  const body = {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
    tools,
  };
  new CodexExecutor().transformRequest("gpt-5.6-sol", body, true, {
    connectionId: "test-optional-tool-args",
    providerSpecificData: {},
  });
  return body.tools;
}

async function translateCodexSse(input, body) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  });
  const output = stream.pipeThrough(createSSETransformStreamWithLogger(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.CLAUDE,
    "codex",
    null,
    null,
    "gpt-5.6-sol",
    null,
    body,
  ));
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

describe("Codex optional tool arguments", () => {
  it("makes optional properties nullable before Codex strictifies the schema", () => {
    const [tool] = transformCodexTools([{
      type: "function",
      name: "Agent",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string" },
          model: { type: "string", enum: ["sonnet", "opus"] },
        },
        required: ["description"],
      },
    }]);

    expect(tool.parameters.properties.description.type).toBe("string");
    expect(tool.parameters.properties.model.type).toEqual(["string", "null"]);
    expect(tool.parameters.properties.model.enum).toEqual(["sonnet", "opus", null]);
  });

  it("removes Codex null placeholders for originally optional fields", async () => {
    const body = {
      tools: [{
        name: "Agent",
        input_schema: {
          type: "object",
          properties: {
            description: { type: "string" },
            model: { type: "string", enum: ["sonnet", "opus"] },
          },
          required: ["description"],
        },
      }],
    };
    const args = JSON.stringify({ description: "review code", model: null });
    const input = [
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: { type: "function_call", call_id: "call_1", name: "Agent" },
      }),
      sseEvent("response.function_call_arguments.delta", {
        output_index: 0,
        delta: args,
      }),
      sseEvent("response.output_item.done", {
        output_index: 0,
        item: { type: "function_call", call_id: "call_1", name: "Agent", arguments: args },
      }),
      sseEvent("response.completed", {
        response: { usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    ].join("");

    const output = await translateCodexSse(input, body);
    const partials = output
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "content_block_delta")
      .map((event) => event.delta?.partial_json || "")
      .join("");

    expect(JSON.parse(partials)).toEqual({ description: "review code" });
  });

  it("does not weaken optional schemas without an explicit type", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
    const [tool] = transformCodexTools([{
      type: "function",
      name: "Probe",
      parameters: {
        type: "object",
        properties: { value: schema },
      },
    }]);

    expect(tool.parameters.properties.value).toEqual(schema);
  });

  it("preserves explicit values and client-declared nullable fields", () => {
    const body = {
      tools: [{
        name: "Agent",
        input_schema: {
          type: "object",
          properties: {
            model: { type: "string" },
            note: { type: ["string", "null"] },
          },
        },
      }],
    };
    const optional = collectOptionalToolFields(body);

    expect(JSON.parse(removeNullOptionalToolFields(
      "Agent",
      JSON.stringify({ model: "opus", note: null }),
      optional,
    ))).toEqual({ model: "opus", note: null });
  });
});
