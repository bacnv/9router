// End-to-end check of the Codex code-mode namespace flatten, run against the
// REAL request payload captured from a `codex exec` session (dumped by the wire
// probe). A synthetic fixture can drift from what the CLI actually sends; this
// one cannot.
//
// Regression: Codex code mode declares its callable tools inside
// `input[0].type="additional_tools"` as a `namespace` group named "functions".
// Codex's router has no handler for the namespace itself and answers a call
// named after it with `unsupported call: functions`; only the bare child names
// (`exec`, `wait`, `request_user_input`) resolve. The translator used to emit
// the namespace as an empty function and drop every child, so every tool call
// the model made was unroutable.
//
// Skips when the capture is absent, so a plain checkout stays green.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";

const CAPTURE = "/tmp/codex-additional-tools.json";

describe.skipIf(!existsSync(CAPTURE))("real codex code-mode namespace payload", () => {
  it("flattens every child and never exposes the namespace as callable", () => {
    const additionalTools = JSON.parse(readFileSync(CAPTURE, "utf8"));
    const out = openaiResponsesToOpenAIRequest("glm-5.3-flash", {
      input: [
        additionalTools,
        { type: "message", role: "user", content: [{ type: "input_text", text: "Run pwd" }] },
      ],
      tool_choice: "auto",
    }, true, null);

    const names = (out.tools || []).map((tool) => tool.function?.name);

    // The namespace itself is not a tool Codex can route a call to.
    expect(names).not.toContain("functions");
    expect(names.every((name) => !name.includes("."))).toBe(true);
    // Its children survive, `exec` as the freeform one.
    expect(names).toContain("exec");
    expect(names).toContain("wait");
    expect(out._customToolNames).toContain("exec");
    // The grammar that tells the model how to call `exec` must survive the hop.
    const exec = out.tools.find((tool) => tool.function?.name === "exec");
    expect(exec.function.parameters.required).toEqual(["input"]);
    expect(exec.function.description).toMatch(/lark|pragma_source/);
  });
});
