# Ollama Quota Model Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display each Ollama quota window's model request counts as a horizontal, wrapping `model count | model count` line.

**Architecture:** Normalize Ollama's upstream `models` arrays in the usage service, preserve them through the existing quota parser, and render the optional data in `QuotaTable`. Keep validation/sorting at the trust boundary so the UI only receives valid `{ name, requestCount }` entries.

**Tech Stack:** Plain JavaScript ESM, React/Next.js, Vitest, existing Tailwind classes.

## Global Constraints

- Keep session and weekly model counts separate.
- Render only `model count`, separated by `|`; do not render `request` or `requests`.
- Sort by `requestCount` descending while preserving upstream order for ties.
- Ignore empty names and non-finite or negative request counts.
- Keep quota bars, percentages, scheduler, database, settings, and other providers unchanged.
- Add no dependency.

---

### Task 1: Preserve Ollama Model Counts

**Files:**
- Modify: `open-sse/services/usage/misc.js:80-109`
- Modify: `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js:525-538`
- Test: `tests/unit/ollama-usage.test.js:25-165`

**Interfaces:**
- Consumes: upstream entries `{ name, request_count }` from `limits.session.models` and `limits.weekly.models`.
- Produces: quota property `models: Array<{ name: string, requestCount: number }>`.

- [ ] **Step 1: Write failing usage and parser tests**

Update `SAMPLE_USAGE` so session and weekly contain distinct, unsorted, invalid, and equal-count entries. Assert the usage result is:

```js
expect(usage.quotas["Session (5h)"].models).toEqual([
  { name: "minimax-m3", requestCount: 2 },
  { name: "gemma4:31b", requestCount: 1 },
]);
expect(usage.quotas["Weekly (7d)"].models).toEqual([
  { name: "kimi-k2.7-code", requestCount: 971 },
  { name: "minimax-m3", requestCount: 422 },
]);
```

Include invalid entries with blank name, negative count, and non-numeric count and assert they are absent. Extend the parser test to assert each row preserves its own `models` array.

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
cd tests && npx vitest run unit/ollama-usage.test.js
```

Expected: FAIL because quota objects and normalized rows do not contain `models`.

- [ ] **Step 3: Implement boundary normalization**

In `getOllamaUsage`, add:

```js
function normalizeModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((model, index) => ({
      name: typeof model?.name === "string" ? model.name.trim() : "",
      requestCount: Number(model?.request_count),
      index,
    }))
    .filter((model) => model.name && Number.isFinite(model.requestCount) && model.requestCount >= 0)
    .sort((a, b) => b.requestCount - a.requestCount || a.index - b.index)
    .map(({ name, requestCount }) => ({ name, requestCount }));
}
```

Extend `ratioQuota` to accept `models` and return `models: normalizeModels(models)`. Pass `limits.session?.models` and `limits.weekly?.models` when creating the corresponding quota.

In `parseQuotaData("ollama", ...)`, preserve:

```js
models: Array.isArray(quota.models) ? quota.models : [],
```

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
cd tests && npx vitest run unit/ollama-usage.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add open-sse/services/usage/misc.js \
  'src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js' \
  tests/unit/ollama-usage.test.js
git commit -m "feat(ollama): expose quota model counts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Render Wrapping Model Counts

**Files:**
- Modify: `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js:162-197`
- Test: `tests/unit/ollama-usage.test.js`

**Interfaces:**
- Consumes: normalized quota property `models: Array<{ name, requestCount }>` from Task 1.
- Produces: optional wrapping line beneath each quota progress row.

- [ ] **Step 1: Add a failing source-contract assertion**

Read `QuotaTable.js` in the existing Ollama test and assert the component maps `quota.models`, uses `flex-wrap`, renders `model.name` and `model.requestCount`, and contains no request-label copy. Keep this source contract narrow because the test package has no DOM environment or React Testing Library.

```js
expect(source).toContain("quota.models.map");
expect(source).toContain("flex-wrap");
expect(source).toContain("model.name");
expect(source).toContain("model.requestCount");
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
cd tests && npx vitest run unit/ollama-usage.test.js
```

Expected: FAIL because `QuotaTable` does not render model data.

- [ ] **Step 3: Implement minimal wrapping UI**

Inside the progress/details column, after the existing used/remaining row, render:

```jsx
{Array.isArray(quota.models) && quota.models.length > 0 && (
  <div className="flex flex-wrap items-center gap-x-1 text-[10px] text-text-muted">
    {quota.models.map((model, index) => (
      <span key={`${model.name}-${index}`} className="whitespace-nowrap">
        {index > 0 && <span className="mr-1">|</span>}
        {model.name} {model.requestCount.toLocaleString()}
      </span>
    ))}
  </div>
)}
```

Do not add provider-specific branching; only quotas with a non-empty `models` array render details.

- [ ] **Step 4: Run focused tests and lint**

Run:

```bash
cd tests && npx vitest run unit/ollama-usage.test.js unit/quota-auto-ping.test.js
cd .. && npx eslint \
  open-sse/services/usage/misc.js \
  'src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js' \
  'src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js' \
  tests/unit/ollama-usage.test.js
```

Expected: tests PASS; no new lint findings.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js' tests/unit/ollama-usage.test.js
git commit -m "feat(ui): show Ollama quota model counts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Final Regression Verification

**Files:** Verify only.

- [ ] **Step 1: Run focused and fork-specific tests**

```bash
cd tests && npx vitest run \
  unit/ollama-usage.test.js \
  unit/quota-auto-ping.test.js \
  unit/settings-route-autoping.test.js \
  unit/xai-usage.test.js \
  unit/xai-usage-route.test.js \
  unit/codex-optional-tool-args.test.js
```

Expected: all tests PASS.

- [ ] **Step 2: Verify diff and repository state**

```bash
git diff v0.5.50-xai-ollama-autoping..HEAD --check
git status --short --branch
git log --oneline --decorate -6
```

Expected: no whitespace errors and a clean working tree. Do not push or move the existing tag without explicit confirmation.
