# xAI OAuth Usage Design

## Goal

Show Grok account quota for `xai` OAuth connections without changing quota behavior for the separate `grok-cli` provider. xAI API-key connections remain unsupported by the Usage API.

## Scope

Implement usage only when:

- `provider === "xai"`
- `authType === "oauth"`

Do not change models, chat dispatch, the Grok CLI executor, the dashboard quota UI, or the database schema.

## Architecture

Use a dedicated `getXaiUsage` entry point backed by the existing Grok billing parser and shared fetch logic. This keeps provider selection explicit while avoiding a second quota parser.

### Provider registry

In `open-sse/providers/registry/xai.js`:

- Enable `features.usage`.
- Declare credits, monthly, and user usage URLs under `transport.usage`.

The endpoints are:

- `/v1/billing?format=credits`
- `/v1/billing`
- `/v1/user?include=subscription`

### Usage dispatch

In `open-sse/services/usage.js`:

- Register a dedicated `xai` handler.
- Route it to `getXaiUsage` rather than directly aliasing `getGrokCliUsage`.

The application usage route retains its OAuth eligibility check, so xAI API-key connections do not call Grok billing endpoints.

### Shared billing implementation

In `open-sse/services/usage/grok-cli.js`:

- Keep `getGrokCliUsage` as the existing Grok CLI entry point.
- Add the smallest shared internal fetch-and-parse path needed by both providers.
- Add `getXaiUsage`, passing xAI's registry usage configuration explicitly.
- Do not make xAI depend implicitly on `U("grok-cli")` or Grok CLI-specific provider selection.

The parser accepts credits and monthly payloads independently and preserves existing fields:

- Percent window: `productUsage[].usagePercent`, falling back to `creditUsagePercent`.
- Monthly limit: `monthlyLimit` and `monthly_limit`.
- Monthly usage: `used`, `includedUsed`, `included_used`, `totalUsed`, and `total_used`.
- On-demand usage: `onDemandCap` and `onDemandUsed`.
- Prepaid balance: `prepaidBalance`.

Normalized quota labels are:

- `Weekly`
- `Monthly`
- `On-demand`
- `Prepaid`

Existing richer credit-envelope parsing remains available.

### Credential refresh

In `open-sse/executors/default.js`, add xAI refresh support for the usage route's forced retry path.

The refresh request must use the connection's `proxyOptions`. It must not delegate to a refresh implementation that uses unproxied global `fetch`. Returned credentials retain the current refresh token when xAI does not rotate it and include the new expiry.

## Data Flow

1. The dashboard requests `GET /api/usage/{connectionId}`.
2. The route confirms that the xAI connection uses OAuth.
3. Credentials are proactively refreshed when near expiry.
4. The xAI usage handler fetches credits, monthly billing, and user metadata in parallel.
5. Successful billing payloads are parsed and merged.
6. The existing normalized quota response is returned to the dashboard.
7. If billing reports expired authentication, the route force-refreshes through the connection proxy and retries once.

## Failure Handling

Billing endpoints are independent data sources:

- Credits failure plus monthly success returns monthly quota.
- Monthly failure plus credits success returns weekly/credit quota.
- User endpoint failure does not suppress numeric quota.
- A single billing `401` or `403` does not discard usable data from the other billing endpoint.
- If no billing endpoint succeeds and authentication failed, return the existing auth-expired message so the route can refresh and retry.
- If no billing endpoint succeeds for non-auth reasons, return an explicit billing error.
- Missing fields omit only the corresponding quota row.

Do not synthesize exhaustion from absent data. `exhausted` is true only when at least one finite quota exists and every finite quota has zero remaining.

Subscription state must not classify `expired`, `cancelled`, or `inactive` tiers as active. Unknown named tiers must not be used as proof of active paid access without a positive access signal.

## Tests

Add focused unit coverage for:

- xAI OAuth weekly percent usage.
- xAI OAuth monthly usage.
- Combined weekly and monthly quotas.
- camelCase and legacy snake_case monthly fields.
- Credits failure with usable monthly data.
- Monthly failure with usable credits data.
- Authentication failure causing refresh and one retry.
- xAI refresh honoring connection proxy configuration.
- xAI API-key connections not calling usage billing endpoints.
- Expired, cancelled, and inactive tiers not being reported as active subscriptions.
- Existing `grok-cli` behavior remaining unchanged.

Run the focused Vitest files and the provider/registry regression baselines required by the repository instructions.

## Completion Criteria

- xAI OAuth connections show every numeric quota exposed by available Grok billing endpoints.
- Partial upstream failure degrades without discarding valid quota data.
- Expired OAuth credentials refresh and retry through the configured connection proxy.
- xAI API-key behavior is unchanged.
- Existing Grok CLI tests and registry baselines show no regression.
