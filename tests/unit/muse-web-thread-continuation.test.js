import { describe, it, expect, vi, beforeEach } from "vitest";

// Thread continuation for muse-web: the caller passes back a `thread_id`, the
// executor reopens that thread so the agent keeps its memory, and echoes the
// id out. 9Router stores no thread state — persistence belongs to the caller.
// Exercised against a fake browser page, so the navigation is real code.

let visited = [];
let closed = 0;
let pageUrl = "";
let readyCalls = 0;
// Number of readiness polls that fail before the page counts as ready. Used to
// model a dead thread (never ready) vs a live one.
let pollsUntilReady = 0;

vi.mock("../../open-sse/executors/browserExecutableCheck.js", () => ({
  isMissingBrowserExecutable: () => false,
  resolveSystemChromeExecutable: () => "/fake/chrome",
}));

vi.mock("../../open-sse/services/browserPool.js", () => ({
  acquireBrowserContext: vi.fn(async () => ({
    context: {
      newPage: async () => makePage(),
      addCookies: async () => {},
    },
  })),
  releaseBrowserContext: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/executors/muse-web/session.js", async (importOriginal) => ({
  ...(await importOriginal()),
  renewSession: async () => ({ cookieHeader: "hatch_sess=x", meta: {} }),
}));

vi.mock("../../open-sse/executors/muse-web/dom.js", () => ({
  PAGE_STATE: "PAGE_STATE",
  CHAT_STATE: "CHAT_STATE",
  INPUT: "textarea",
  AGENT_BUBBLE: "bubble",
  ATTACHMENT: "att",
  STOP_BUTTON: "stop",
  APPROVAL_CARD: "approval",
  FILE_INPUT: "file",
  LOGIN_HINTS: [],
  QUOTA_HINTS: [],
  STALL_HINTS: [],
}));

function makePage() {
  const page = {
    url: () => pageUrl,
    goto: async (url) => { visited.push(url); },
    evaluate: async (script) => {
      if (script !== "PAGE_STATE") return {};
      readyCalls++;
      if (readyCalls <= pollsUntilReady) throw new Error("still loading");
      return { ready: true, head: "", path: "/x" };
    },
    close: async () => { closed++; },
    fill: async () => {},
    keyboard: { press: async () => {} },
    waitForTimeout: async () => {},
  };
  return page;
}

beforeEach(() => {
  visited = [];
  closed = 0;
  readyCalls = 0;
  pollsUntilReady = 0;
  pageUrl = "https://muse.ai/thread/new";
  vi.clearAllMocks();
});

async function executor() {
  const { default: MuseWebExecutor } = await import("../../open-sse/executors/muse-web.js");
  return new MuseWebExecutor();
}

describe("_openThreadPage", () => {
  it("opens /thread/new when no id is given", async () => {
    const ex = await executor();
    await ex._openThreadPage({ apiKey: "hatch_sess=x" }, {});
    expect(visited).toEqual(["https://muse.ai/thread/new"]);
  });

  it("reopens the given thread instead of starting a new one", async () => {
    const ex = await executor();
    await ex._openThreadPage({ apiKey: "hatch_sess=x" }, { threadId: "abc-123" });
    expect(visited).toEqual(["https://muse.ai/thread/abc-123"]);
  });

  it("URL-encodes the id so it cannot escape the path", async () => {
    const ex = await executor();
    await ex._openThreadPage({ apiKey: "hatch_sess=x" }, { threadId: "../../api/session" });
    expect(visited).toEqual(["https://muse.ai/thread/..%2F..%2Fapi%2Fsession"]);
  });
});
