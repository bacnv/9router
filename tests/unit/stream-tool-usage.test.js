import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import "../../open-sse/translator/index.js";

async function runStream(chunks, onComplete) {
  const source = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const output = source.pipeThrough(createSSETransformStreamWithLogger(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    "charm",
    null,
    null,
    "qwen3.8-flash",
    "connection-1",
    { model: "charm/qwen3.8-flash", messages: [{ role: "user", content: "list files" }] },
    onComplete,
  ));

  await new Response(output).text();
}

describe("stream tool-call usage", () => {
  it("estimates usage for tool-only OpenAI-compatible responses", async () => {
    let completedUsage;
    await runStream([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: "" } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ], (_content, usage) => { completedUsage = usage; });

    expect(completedUsage?.input_tokens).toBeGreaterThan(0);
    expect(completedUsage?.output_tokens).toBeGreaterThan(0);
  });
});
