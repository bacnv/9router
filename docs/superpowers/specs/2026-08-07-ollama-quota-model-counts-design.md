# Ollama Quota Model Counts Design

## Goal

Show Ollama Cloud model request counts beneath each quota row without changing the existing remaining-percentage display.

## Data Contract

`getOllamaUsage` preserves the model list returned for each Ollama limit:

- `limits.session.models` belongs to `Session (5h)`.
- `limits.weekly.models` belongs to `Weekly (7d)`.
- Each normalized model item contains `name` and `requestCount`.

Session and weekly values remain separate; counts are not combined across quota windows.

Invalid entries are omitted:

- `name` must be a non-empty string.
- `request_count` must be a finite, non-negative number.

Models are sorted by request count descending. Equal counts retain the upstream order.

## UI

Keep the current quota name, progress bar, used percentage, remaining percentage, and reset display unchanged.

Below each Ollama quota's progress details, render one wrapping line in this format:

```text
kimi-k2.7-code 971 | minimax-m3 422 | glm-5.1 22 | gemma4:31b 2
```

Rules:

- Display only `model count`; do not show `request` or `requests`.
- Separate entries with `|`.
- Lay entries out horizontally and wrap naturally when the card is too narrow.
- Do not render the detail line when the quota has no valid model entries.
- Apply this detail rendering only when a normalized quota provides model counts; other providers remain unchanged.

## Data Flow

1. `getOllamaUsage` maps `limits.session.models` and `limits.weekly.models` into the corresponding normalized quota objects.
2. `normalizeQuotaData` preserves each quota's model list.
3. `QuotaTable` renders the optional model-count line beneath that quota's progress information.

No database, settings, scheduler, API endpoint, or dependency change is required.

## Error Handling

Malformed or missing model data is ignored while quota percentages continue to render. A malformed model entry must not fail the Ollama usage response or the Usage page.

## Tests

- Extend Ollama usage tests to verify session and weekly models remain separate, invalid entries are omitted, and counts are sorted descending.
- Extend quota normalization tests to verify model data survives normalization.
- Add the smallest runnable UI/helper test supported by the existing Vitest setup for the `model count | model count` representation; avoid adding a browser test dependency solely for this change.
- Preserve the Ollama auto-ping, xAI usage, and optional tool-call regression tests.

## Non-Goals

- Combining counts across session and weekly windows.
- Showing activity cost or the four-week activity model list.
- Filtering, pagination, expansion controls, or model links.
- Showing the words `request` or `requests`.
