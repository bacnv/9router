// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { consumeClaudeResetGrant } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { buildResetQuotaStateUpdate } from "open-sse/services/accountFallback.js";
import { refreshAndUpdateCredentials } from "../route.js";

// Spend one free Claude "limit reset" grant (irreversible)
export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;
    const { grantId } = await request.json().catch(() => ({}));

    let connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (connection.provider !== "claude" || connection.authType !== "oauth") {
      return Response.json({ error: "Limit reset is only available for Claude OAuth connections." }, { status: 400 });
    }

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    ({ connection } = await refreshAndUpdateCredentials(connection, false, proxyOptions));
    const result = await consumeClaudeResetGrant(connection.accessToken, grantId, proxyOptions);

    if (result.ok) {
      // The grant refilled the upstream limits, but nothing else knows: the failure
      // that locked this account+model is a row in our DB (modelLock_<model> plus
      // lastError/testStatus). Leave it and every later request keeps skipping the
      // account until the old expiry, which is exactly the "quota is back but Claude
      // Code is still blocked" report. Clearing is safe — a still-exhausted window
      // re-locks on its next 429 with a fresh reset time.
      await updateProviderConnection(connectionId, buildResetQuotaStateUpdate(connection))
        .catch((e) => console.warn(`[Claude Reset] cleared upstream, but lock cleanup failed: ${e.message}`));
      return Response.json(result);
    }
    const status = result.status >= 400 && result.status < 500 ? result.status : 409;
    return Response.json({ ...result, message: result.message || `Reset not applied: ${result.reason || result.result || "unknown"}` }, { status });
  } catch (error) {
    console.warn(`[Claude Reset] ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
