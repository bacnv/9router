import { NextResponse } from "next/server";
import { createProviderConnection, deleteProviderConnection, getProviderConnections, updateProviderConnection } from "@/models";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { startWebLogin, getWebLoginStatus, cancelWebLogin, listWebLoginProfiles } from "open-sse/services/webLogin.js";
import { getWebLoginConfig, listWebLoginProviders } from "open-sse/services/webLoginConfig.js";
import { fetchWebIdentity } from "open-sse/services/webIdentity.js";

/**
 * Interactive web login: open a headed browser at the provider's login page,
 * let the user log in by hand, harvest cookies/localStorage, auto-create the
 * connection. The cookie itself never travels back to the client — only a
 * short preview does.
 */

// GET /api/providers/web-login            → supported provider list
// GET /api/providers/web-login?provider=x → session status (saves once on success)
export async function GET(request) {
  const provider = request.nextUrl.searchParams.get("provider");
  if (!provider) {
    return NextResponse.json({ providers: listWebLoginProviders(), profiles: listWebLoginProfiles() });
  }
  const session = getWebLoginStatus(provider);
  if (!session) {
    return NextResponse.json({ error: "No login session for this provider" }, { status: 404 });
  }

  if (session.status === "success" && !session.savedConnectionId) {
    try {
      const config = getWebLoginConfig(provider);
      const identity = await fetchWebIdentity(provider, session.credential);
      // A login that just finished in the browser is authoritative: an
      // "invalid" verdict here means the probe endpoint rejected the request
      // shape, not that the user's session is stale.
      if (identity.status === "invalid") {
        session.status = "error";
        session.error = identity.error || "The captured session was rejected";
        return NextResponse.json({
          provider,
          status: session.status,
          profile: session.profile || null,
          error: session.error,
        });
      }

      const providerName = AI_PROVIDERS[provider]?.name || provider;
      const email = identity.email || "";
      // Store which browser profile this session came from. It is the only
      // account discriminator for providers whose identity probe returns no
      // email (muse-web), and it lets a second Google account keep its own row.
      const profile = session.profile || "default";
      const baseName = email || providerName;
      const name = profile === "default" ? baseName : `${baseName} (${profile})`;
      session.accountEmail = email;
      const providerSpecificData = {
        authMethod: "web-login",
        profile,
        ...(config?.credentialFrom === "localStorageValue" ? { tokenSource: "localStorage" } : {}),
      };

      // Re-login refreshes the same row in place. Identity is (email, profile):
      // a second Google account or a second browser profile keeps its own row.
      // Providers that expose no email (muse-web) dedupe on the profile alone —
      // without it every login collapsed onto the one row the button created,
      // so a second muse.ai account silently overwrote the first.
      const webLoginRows = (await getProviderConnections({ provider }))
        .filter((c) => c.providerSpecificData?.authMethod === "web-login")
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      const recordedProfile = (c) => c.providerSpecificData?.profile || null;
      const sameIdentity = (c) => (recordedProfile(c) ?? "default") === profile
        && (email ? c.email === email : true);
      const existing = webLoginRows.find(sameIdentity)
        // Rows written before profiles were recorded carry no email and no
        // profile; adopt the default profile's row rather than leaving a
        // duplicate behind on the next login.
        ?? (profile === "default" && !email
          ? webLoginRows.find((c) => !recordedProfile(c) && !c.email)
          : null)
        ?? null;

      if (existing) {
        const updated = await updateProviderConnection(existing.id, {
          apiKey: session.credential,
          name,
          email: email || existing.email || null,
          providerSpecificData: { ...existing.providerSpecificData, ...providerSpecificData },
          testStatus: "active",
          lastError: null,
          lastErrorAt: null,
          isActive: true,
        });
        session.savedConnectionId = updated?.id || existing.id;
        // Same identity logged in twice used to leave a stale duplicate row.
        // Only rows of THIS (email, profile) identity are duplicates — a bare
        // email match now spans profiles and would delete the other account.
        for (const duplicate of webLoginRows) {
          if (duplicate.id === existing.id) continue;
          if (!sameIdentity(duplicate)) continue;
          await deleteProviderConnection(duplicate.id);
        }
      } else {
        const connection = await createProviderConnection({
          provider,
          authType: "cookie",
          name,
          email: email || null,
          apiKey: session.credential,
          priority: 1,
          providerSpecificData,
          isActive: true,
          // Harvested from a live logged-in session, so the credential is known good.
          testStatus: "active",
          allowOverwrite: false,
        });
        session.savedConnectionId = connection.id;
      }
      session.credential = undefined; // drop the secret once persisted
    } catch (error) {
      session.status = "error";
      session.error = error?.code === "PROVIDER_NAME_CONFLICT"
        ? `A connection named "${error.existingName}" already exists — edit or delete it first`
        : error?.message || "Failed to save connection";
    }
  }

  return NextResponse.json({
    provider,
    status: session.status,
    profile: session.profile || null,
    error: session.error || null,
    connectionId: session.savedConnectionId || null,
    email: session.accountEmail || null,
    credentialPreview: session.credential ? `${session.credential.slice(0, 10)}…` : null,
  });
}

// POST /api/providers/web-login {provider, profile?} → start login window
export async function POST(request) {
  try {
    const body = await request.json();
    const provider = String(body?.provider || "").trim();
    const profile = String(body?.profile || "").trim() || "default";
    if (!getWebLoginConfig(provider)) {
      return NextResponse.json({ error: `Web login not supported for "${provider}"` }, { status: 400 });
    }
    const session = await startWebLogin(provider, profile);
    return NextResponse.json({ provider, profile: session.profile, status: session.status }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to start login" }, { status: 500 });
  }
}

// DELETE /api/providers/web-login?provider=x → cancel a running session
export async function DELETE(request) {
  const provider = request.nextUrl.searchParams.get("provider");
  if (!provider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }
  return NextResponse.json({ cancelled: cancelWebLogin(provider) });
}
