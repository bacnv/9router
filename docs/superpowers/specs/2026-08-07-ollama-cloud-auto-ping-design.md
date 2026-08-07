# Ollama Cloud Auto-Ping Design

## Goal

Add opt-in auto-ping for each Ollama Cloud API-key connection so its five-hour activity window remains warm. The next ping is scheduled five hours after the previous successful ping.

## Behavior

- Reuse the existing quota auto-ping scheduler and per-connection settings UI used by Claude and Codex.
- Add an `ollamaAutoPing` setting keyed by connection ID.
- Only active Ollama Cloud API-key connections explicitly enabled by the user are eligible.
- Send the first ping when no successful ping has been recorded, then send subsequent pings when `lastPingAt` is at least five hours old.
- Before pinging, fetch Ollama Cloud usage and require both reported limits to have remaining quota:
  - `Session (5h)` remaining percentage must be greater than zero.
  - `Weekly (7d)` remaining percentage must be greater than zero.
- The UI quota values are remaining percentages: 100% means fully available and 0% means exhausted.
- A successful ping updates `lastPingAt`; a failed ping does not move the five-hour schedule.
- A failed ping enters the scheduler's existing 15-minute failure cooldown.

## Ping Request

Send one minimal request through the existing Ollama executor/transport:

- Endpoint: Ollama Cloud chat transport (`https://ollama.com/api/chat`).
- Model: `gemma4`.
- Prompt: `hi`.
- Streaming: disabled.
- Maximum generated tokens: one (`options.num_predict: 1`).
- Authentication: the connection's API key.
- Proxy behavior: use the connection's existing proxy configuration.
- Do not fall back to another model when `gemma4` is unavailable or the request fails.

## Implementation Boundaries

- Extend `QUOTA_AUTOPING_CONFIG` with Ollama's settings key, five-hour interval, model, and minimal request values.
- Add an Ollama handler to `quotaAutoPing.js` using `getOllamaUsage` and the existing executor.
- Permit API-key authentication for Ollama while preserving OAuth-only filtering for Claude and Codex.
- Include `ollamaAutoPing` when deciding whether to start or stop the shared scheduler.
- Extend the existing provider connection/settings UI rather than introducing a separate Ollama scheduler or page.
- No database schema change is expected because settings and connection metadata already store JSON fields used by auto-ping.

## Error Handling

- Missing/invalid API key, unavailable usage data, exhausted quota, or failed ping must fail open for the rest of the application.
- Do not update `lastPingAt` unless the Ollama response is successful.
- Reuse the shared failure cache to suppress repeated attempts for 15 minutes.
- Log success or failure using the existing `[AutoPing] provider:connection` format without exposing the API key.

## Tests

Extend `tests/unit/quota-auto-ping.test.js` using test-first development to verify:

1. An enabled Ollama API-key connection with no prior successful ping sends a minimal `gemma4` request.
2. A connection is not pinged until five hours have elapsed since `lastPingAt`.
3. A connection is pinged once five hours have elapsed.
4. Session or weekly remaining quota at 0% prevents the ping.
5. A failed request does not update `lastPingAt` and activates failure cooldown.
6. The scheduler starts when only an Ollama connection is opted in and stops after the last opt-in is disabled.
7. Existing Claude and Codex auto-ping tests continue to pass.

## Non-Goals

- Inferring Ollama's exact quota reset timestamp; its usage API does not expose one.
- Automatically selecting or falling back to another model.
- Pinging inactive or non-opted-in connections.
- Changing how quota percentages are displayed.
