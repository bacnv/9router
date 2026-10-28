import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import "../../open-sse/translator/index.js";

function createStream(chunks, onComplete, close = true) {
  const source = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
  return source.pipeThrough(createSSETransformStreamWithLogger(
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
}

async function runStream(chunks, onComplete) {
  await new Response(createStream(chunks, onComplete)).text();
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

  it("finalizes before a client closes after the finish chunk", async () => {
    let completedUsage;
    const output = createStream([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: "Bash", arguments: '{"command":"ls"}' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    ], (_content, usage) => { completedUsage = usage; }, false);
    const reader = output.getReader();

    // The source never closes, so the only stop condition is the early-finalize
    // timer armed by the finish chunk. Drain in the background (a bare read()
    // blocks forever) and wait for the callback, then cancel the reader.
    const pump = (async () => {
      try { while (!(await reader.read()).done) { /* drain */ } } catch { /* cancelled */ }
    })();
    while (!completedUsage) await new Promise((r) => setTimeout(r, 10));
    await reader.cancel();
    await pump;

    expect(completedUsage?.input_tokens).toBeGreaterThan(0);
    expect(completedUsage?.output_tokens).toBeGreaterThan(0);
  });

  // Synthetic (vLLM) splits usage: the finish_reason chunk carries only
  // prompt/completion, and a trailing choices:[] chunk carries cached_tokens.
  // Persisting on the finish chunk billed the whole prompt at the input rate.
  it("keeps cached_tokens from a usage trailer that follows the finish chunk", async () => {
    let completedUsage;
    await runStream([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 2833, completion_tokens: 5, total_tokens: 2838 } })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2833, completion_tokens: 5, total_tokens: 2838, prompt_tokens_details: { cached_tokens: 2816 } } })}\n\n`,
      "data: [DONE]\n\n",
    ], (_content, usage) => { completedUsage = usage; });

    expect(completedUsage?.prompt_tokens).toBe(2833);
    expect(completedUsage?.cached_tokens).toBe(2816);
  });

  // The lane Synthetic actually runs on: OpenAI client -> OpenAI-compatible
  // upstream is a passthrough, so the early finalize there has to wait too.
  it("passthrough lane also keeps the cache trailer", async () => {
    let completedUsage;
    const source = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 2833, completion_tokens: 5 } })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2833, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2816 } } })}\n\n`,
          "data: [DONE]\n\n",
        ]) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    await new Response(source.pipeThrough(createPassthroughStreamWithLogger(
      "synthetic", null, "syn:large:text", "connection-1",
      { model: "synthetic/syn:large:text", messages: [{ role: "user", content: "hi" }] },
      (_content, usage) => { completedUsage = usage; },
    ))).text();

    expect(completedUsage?.prompt_tokens).toBe(2833);
    expect(completedUsage?.cached_tokens).toBe(2816);
  });
});
