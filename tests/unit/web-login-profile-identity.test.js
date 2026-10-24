import { describe, it, expect, vi, beforeEach } from "vitest";

// The web-login route's save step: which existing row a finished capture
// refreshes. muse-web's identity probe returns no email, so before profiles
// were recorded every login collapsed onto the single row the button created
// and a second account silently overwrote the first.

const created = [];
const updated = [];
const deleted = [];
let existingRows = [];

vi.mock("@/models", () => ({
  getProviderConnections: vi.fn(async () => existingRows),
  createProviderConnection: vi.fn(async (data) => {
    const row = { id: `new-${created.length}`, ...data };
    created.push(row);
    existingRows = [...existingRows, row];
    return row;
  }),
  updateProviderConnection: vi.fn(async (id, patch) => {
    updated.push({ id, patch });
    const row = existingRows.find((c) => c.id === id);
    Object.assign(row, patch);
    return row;
  }),
  deleteProviderConnection: vi.fn(async (id) => {
    deleted.push(id);
    existingRows = existingRows.filter((c) => c.id !== id);
  }),
}));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: { "muse-web": { name: "Muse Web" } },
}));

vi.mock("open-sse/services/webLogin.js", () => ({
  startWebLogin: vi.fn(),
  cancelWebLogin: vi.fn(),
  listWebLoginProfiles: vi.fn(() => []),
  getWebLoginStatus: vi.fn(() => null),
}));

vi.mock("open-sse/services/webLoginConfig.js", () => ({
  getWebLoginConfig: vi.fn(() => ({ loginUrl: "https://muse.ai/", cookieDomain: ".muse.ai" })),
  listWebLoginProviders: vi.fn(() => ["muse-web"]),
}));

const identity = { status: "ok", email: "" };
vi.mock("open-sse/services/webIdentity.js", () => ({
  fetchWebIdentity: vi.fn(async () => identity),
}));

const { getWebLoginStatus } = await import("open-sse/services/webLogin.js");
const { NextResponse } = await import("next/server");
const { GET } = await import("../../src/app/api/providers/web-login/route.js");

function finishLogin({ profile, credential = "hatch_sess=abc", email = "" }) {
  identity.email = email;
  getWebLoginStatus.mockReturnValue({
    status: "success",
    profile,
    credential,
    savedConnectionId: null,
  });
  return GET({ nextUrl: { searchParams: new URLSearchParams("provider=muse-web") } });
}

beforeEach(() => {
  created.length = 0;
  updated.length = 0;
  deleted.length = 0;
  existingRows = [];
  identity.email = "";
  vi.clearAllMocks();
});

describe("web-login save: profile is part of the identity", () => {
  it("keeps a row per profile when the provider exposes no email", async () => {
    await finishLogin({ profile: "default", credential: "hatch_sess=one" });
    await finishLogin({ profile: "bacnv87", credential: "hatch_sess=two" });

    expect(created).toHaveLength(2);
    expect(created.map((c) => c.providerSpecificData.profile)).toEqual(["default", "bacnv87"]);
    expect(created.map((c) => c.apiKey)).toEqual(["hatch_sess=one", "hatch_sess=two"]);
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it("refreshes the same row when the same profile logs in again", async () => {
    await finishLogin({ profile: "bacnv87", credential: "hatch_sess=old" });
    await finishLogin({ profile: "bacnv87", credential: "hatch_sess=new" });

    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(updated[0].patch.apiKey).toBe("hatch_sess=new");
    expect(deleted).toHaveLength(0);
  });

  it("names a non-default profile so the two rows are tellable apart", async () => {
    await finishLogin({ profile: "default" });
    await finishLogin({ profile: "bacnv87" });

    expect(created.map((c) => c.name)).toEqual(["Muse Web", "Muse Web (bacnv87)"]);
  });

  it("still separates two accounts that do report an email", async () => {
    await finishLogin({ profile: "default", email: "a@example.com" });
    await finishLogin({ profile: "default", email: "b@example.com" });

    expect(created).toHaveLength(2);
    expect(deleted).toHaveLength(0);
  });

  it("never deletes another profile's row when refreshing", async () => {
    await finishLogin({ profile: "default", credential: "hatch_sess=one" });
    await finishLogin({ profile: "bacnv87", credential: "hatch_sess=two" });
    await finishLogin({ profile: "default", credential: "hatch_sess=one-b" });

    expect(created).toHaveLength(2);
    expect(deleted).toHaveLength(0);
    expect(existingRows.map((c) => c.apiKey).sort()).toEqual(["hatch_sess=one-b", "hatch_sess=two"]);
  });

  it("adopts a pre-profile row instead of leaving a duplicate", async () => {
    existingRows = [{
      id: "legacy",
      provider: "muse-web",
      authType: "cookie",
      name: "Muse Web",
      email: null,
      apiKey: "hatch_sess=old",
      providerSpecificData: { authMethod: "web-login" },
    }];

    await finishLogin({ profile: "default", credential: "hatch_sess=new" });

    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe("legacy");
    expect(updated[0].patch.providerSpecificData.profile).toBe("default");
  });
});
