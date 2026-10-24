import { describe, it, expect } from "vitest";
import { toMuseCookies } from "../../open-sse/executors/muse-web/session.js";
import { chatGptWebStorageStateFromCookieHeader } from "../../open-sse/executors/chatgpt-web/adapter.js";

// Chrome rejects a whole addCookies() batch with "Invalid cookie fields" when a
// `__Host-` cookie carries a Domain attribute, so every cookie-replay path must
// give those the bare host. Verified live against Chrome 155:
//   ".muse.ai"  -> Invalid cookie fields
//   "muse.ai"   -> accepted, lands as a host cookie
//   (omitted)   -> "Cookie should have a url or a domain/path pair"
const HOST_ONLY = "__Host-hatch_one_tap";

describe("toMuseCookies", () => {
  it("gives __Host- cookies the bare host, not the parent domain", () => {
    const cookies = toMuseCookies(`hatch_sess=abc; ${HOST_ONLY}=xyz`);
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));

    expect(byName[HOST_ONLY].domain).toBe("muse.ai");
    expect(byName.hatch_sess.domain).toBe(".muse.ai");
  });

  it("keeps the full jar: one __Host- cookie must not drop the session cookies", () => {
    const header = "hatch_sess=a; hatch_gw=b; hatch_vml=c; hatch_native_auth_device=d; " + HOST_ONLY + "=e";
    expect(toMuseCookies(header).map((c) => c.name)).toEqual([
      "hatch_sess",
      "hatch_gw",
      "hatch_vml",
      "hatch_native_auth_device",
      HOST_ONLY,
    ]);
  });

  it("marks every cookie secure and root-scoped so __Host- stays valid", () => {
    for (const cookie of toMuseCookies(`hatch_sess=a; ${HOST_ONLY}=b`)) {
      expect(cookie.path).toBe("/");
      expect(cookie.secure).toBe(true);
    }
  });

  it("skips cookie attributes that are not pairs", () => {
    const cookies = toMuseCookies("hatch_sess=a; Path=/; Domain=.muse.ai; HttpOnly; SameSite=Lax");
    expect(cookies.map((c) => c.name)).toEqual(["hatch_sess"]);
  });
});

// Same rule on every provider that replays a harvested jar into a browser.
describe("chatGptWebStorageStateFromCookieHeader", () => {
  it("gives __Host- cookies the bare host, not the parent domain", () => {
    const state = chatGptWebStorageStateFromCookieHeader(
      "__Secure-next-auth.session-token=abc; __Host-chatgpt_region=xyz"
    );
    const byName = Object.fromEntries(state.cookies.map((c) => [c.name, c]));

    expect(byName["__Host-chatgpt_region"].domain).toBe("chatgpt.com");
    expect(byName["__Secure-next-auth.session-token"].domain).toBe(".chatgpt.com");
  });
});
