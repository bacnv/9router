import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Chat-side continuity and liveness. The executor drives a real browser, so
// these assert the decision rules in the source rather than re-running them:
// the behaviour they encode was measured against muse.ai (see the commit).
const SRC = readFileSync(new URL("../../open-sse/executors/muse-web.js", import.meta.url), "utf8");

const constOf = (name) => {
  const m = SRC.match(new RegExp(`const ${name} = (\\d+);`));
  return m ? Number(m[1]) : null;
};

describe("muse chat: thread continuity", () => {
  it("accepts thread_id so a chat turn joins the caller's conversation", () => {
    expect(SRC).toMatch(/threadId: requestBody\.thread_id \|\| null/);
  });

  it("passes it into the page opener, which reopens that thread", () => {
    // The chat path must thread it through _openThreadPage, not ignore it.
    const chatOpen = SRC.slice(
      SRC.indexOf("// `thread_id` continues an earlier conversation"),
      SRC.indexOf("const base = await readChatBaseline(page);")
    );
    expect(chatOpen).toMatch(/threadId:\s*requestBody\.thread_id/);
  });

  it("echoes the resolved id on both response shapes", () => {
    expect(SRC).toMatch(/formatChatCompletion\(responseText, modelId, "stop", settledThreadId\)/);
    expect(SRC).toMatch(/formatStreamChunk\("", modelId, "stop", settledThreadId\)/);
  });

  it("waits for muse to rewrite the URL instead of reading it once", () => {
    // Reading immediately after sendPrompt returned null: the URL only becomes
    // /thread/<id> once the agent starts replying.
    expect(SRC).toMatch(/const awaitThreadId = async/);
    expect(SRC).toMatch(/const id = readThreadId\(page\);\s*\n\s*if \(id\) return id;/);
    // Every response path must go through a waiting helper: the non-stream path
    // uses awaitThreadId, the stream path has its own bound to streamPage.
    expect(SRC).toMatch(/await awaitThreadId\(5000\)/);
    expect(SRC).toMatch(/await awaitStreamThreadId\(\)/);
  });

  it("omits thread_id entirely when the provider returned none", () => {
    expect(SRC.match(/\.\.\.\(threadId \? \{ thread_id: threadId \} : \{\}\)/g)).toHaveLength(2);
  });
});

describe("muse chat: liveness instead of a short wall clock", () => {  it("allows the agent real working time before the first token", () => {
    // 45s cut off exactly the requests that needed to read the workspace.
    expect(constOf("FIRST_TOKEN_TIMEOUT_MS")).toBeGreaterThanOrEqual(180000);
  });

  it("keeps an overall ceiling so a hung turn still ends", () => {
    expect(constOf("CHAT_TIMEOUT_MS")).toBeGreaterThan(constOf("FIRST_TOKEN_TIMEOUT_MS"));
  });

  it("only gives up after a stretch with no activity at all", () => {
    const idle = constOf("NO_ACTIVITY_TIMEOUT_MS");
    expect(idle).toBeGreaterThan(0);
    expect(idle).toBeLessThan(constOf("FIRST_TOKEN_TIMEOUT_MS"));
    expect(SRC).toMatch(/Date\.now\(\) - lastActivityAt > NO_ACTIVITY_TIMEOUT_MS/);
  });

  it("counts a working indicator as activity, so a busy turn is not killed", () => {
    expect(SRC).toMatch(/const WORKING_HINTS = \[[^\]]*"thinking"/);
    expect(SRC).toMatch(/WORKING_HINTS\.some\(\(h\) => tail\.includes\(h\)\)/);
  });

  it("counts a new bubble, more text, a new attachment or the stop button as activity", () => {
    expect(SRC).toMatch(/signature !== lastSignature/);
    expect(SRC).toMatch(/st\.generating \|\|/);
    expect(SRC).toMatch(/attachments\?\.length \|\| 0/);
  });

  it("treats an answered approval as activity too", () => {
    const approval = SRC.slice(SRC.indexOf("if (st.approval) {"), SRC.indexOf("const text = st.lastText"));
    expect(approval).toMatch(/lastActivityAt = Date\.now\(\)/);
  });
});

// `thread_id` is not part of any translator's wire format, so the translation
// layer dropped it and every chat turn started a fresh muse thread.
const CORE = readFileSync(new URL("../../open-sse/handlers/chatCore.js", import.meta.url), "utf8");

describe("chatCore carries thread_id through translation", () => {
  it("copies thread_id onto the translated body when a translator dropped it", () => {
    expect(CORE).toMatch(/if \(body\?\.thread_id && !translatedBody\.thread_id\)/);
    expect(CORE).toMatch(/translatedBody\.thread_id = body\.thread_id;/);
  });

  it("does not overwrite a value a translator already set", () => {
    expect(CORE).toMatch(/!translatedBody\.thread_id/);
  });

  it("places the copy after the translation branch so both paths get it", () => {
    const branch = CORE.indexOf("stripContinuityFields(translatedBody);");
    const copy = CORE.indexOf("translatedBody.thread_id = body.thread_id;");
    expect(branch).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(branch);
  });
});

describe("stream path reads the id off its own page", () => {
  it("does not close over the nulled `page`", () => {
    // `page = null` runs before the stream starts, so a closure over it would
    // always return a null thread id.
    const streamBlock = SRC.slice(SRC.indexOf("if (stream) {"), SRC.indexOf("const responseText = await pollChat"));
    expect(streamBlock).toMatch(/readThreadId\(streamPage\)/);
    expect(streamBlock).toMatch(/await awaitStreamThreadId\(\)/);
    expect(streamBlock).not.toMatch(/await awaitThreadId\(/);
  });
});
