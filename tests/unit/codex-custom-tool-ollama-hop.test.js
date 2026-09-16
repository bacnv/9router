// Regression: a Codex code-mode custom tool (`exec`) must come back out as
// `custom_tool_call` on BOTH provider paths, not only the OpenAI-shaped one.
//
// Codex routes a custom tool by item type: `function_call` for an ordinary
// tool, `custom_tool_call` for a freeform one. When the gateway announces
// `exec` as a `function_call`, Codex aborts the turn with
//
//   Fatal error: tool exec invoked with incompatible payload
//
// so a model served over Ollama (deepseek-v4.1-flash) could never call `exec`,
// while the same request over an OpenAI-shaped provider (glm-5.3-flash)
// worked. The Ollama hop adds a translation leg (ollama -> openai ->
// openai-responses) that the custom-tool metadata has to survive.
import { describe, expect, it } from "vitest";
import { translateResponse, translateRequest, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const program = '{"input":"text(1+1)"}';
const namespace = {
  type: "namespace",
  name: "functions",
  description: "",
  tools: [{ type: "custom", name: "exec", description: "Run JS.", format: { type: "text" } }],
};

// Ollama streams one message per chunk with tool_calls under `message`.
const ollamaChunks = [
  {
    model: "deepseek-v4.1-flash",
    message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "exec", arguments: program } }] },
  },
  { model: "deepseek-v4.1-flash", done: true, done_reason: "stop" },
];

const chatChunks = [
  {
    id: "chatcmpl-1",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: program } }] }, finish_reason: null }],
  },
  { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];

function collect(targetFormat, chunks) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  state.customToolNames = new Set(["exec"]);
  const out = [];
  for (const chunk of chunks) out.push(...translateResponse(targetFormat, FORMATS.OPENAI_RESPONSES, chunk, state));
  out.push(...translateResponse(targetFormat, FORMATS.OPENAI_RESPONSES, null, state));
  return out.flat().filter(Boolean);
}

function doneItems(events) {
  return events.filter((event) => event.event === "response.output_item.done").map((event) => event.data.item);
}

describe("Codex custom tool survives every provider hop", () => {
  it("emits custom_tool_call for an OpenAI-shaped provider", () => {
    const items = doneItems(collect(FORMATS.OPENAI, chatChunks));
    expect(items.map((item) => item.type)).toContain("custom_tool_call");
    const call = items.find((item) => item.type === "custom_tool_call");
    expect(call.name).toBe("exec");
    expect(call.input).toBe("text(1+1)");
  });

  it("emits custom_tool_call for an Ollama-shaped provider", () => {
    const items = doneItems(collect(FORMATS.OLLAMA, ollamaChunks));
    expect(items.map((item) => item.type)).toContain("custom_tool_call");
    const call = items.find((item) => item.type === "custom_tool_call");
    expect(call.name).toBe("exec");
    expect(call.input).toBe("text(1+1)");
  });

  it("keeps the custom-tool metadata across the request-side second hop", () => {
    const body = {
      input: [
        { type: "additional_tools", role: "developer", tools: [namespace] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Run" }] },
      ],
      tool_choice: "auto",
    };
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OLLAMA, "deepseek-v4.1-flash", body, true, null);
    expect(translated._customToolNames).toEqual(["exec"]);
    expect(translated.tools.map((tool) => tool.function.name)).toEqual(["exec"]);
  });
});
