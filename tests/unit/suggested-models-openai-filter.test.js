import { describe, expect, it } from "vitest";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

describe("openai suggested-models filter", () => {
  it("maps the standard {data:[…]} catalog to id/name/contextLength", () => {
    const rows = FILTERS.openai([
      { id: "glm-5.3", object: "model", display_name: "GLM 5.3", context_window: 204800 },
      { id: "gemma-4-26b-a4b-it", display_name: "Gemma 4 26B", context_window: 131072 },
    ]);

    expect(rows).toEqual([
      { id: "gemma-4-26b-a4b-it", name: "Gemma 4 26B", contextLength: 131072 },
      { id: "glm-5.3", name: "GLM 5.3", contextLength: 204800 },
    ]);
  });

  it("falls back to name, then id, when display_name is absent", () => {
    const rows = FILTERS.openai([
      { id: "b", name: "Plain Name" },
      { id: "a" },
    ]);

    expect(rows).toEqual([
      { id: "a", name: "a", contextLength: undefined },
      { id: "b", name: "Plain Name", contextLength: undefined },
    ]);
  });

  it("drops entries with no usable id and tolerates a non-array payload", () => {
    const rows = FILTERS.openai([
      { id: "" },
      { id: "   " },
      { name: "no id at all" },
      null,
      { id: "kept" },
    ]);

    expect(rows).toEqual([{ id: "kept", name: "kept", contextLength: undefined }]);
    expect(FILTERS.openai(undefined)).toEqual([]);
    expect(FILTERS.openai({ data: [] })).toEqual([]);
  });

  it("reads context_length as well as context_window", () => {
    // Venice sends context_length and no name field at all (verified live).
    const rows = FILTERS.openai([
      { id: "venice-uncensored-1-2", context_length: 32768 },
      { id: "other", context_window: 131072 },
    ]);

    expect(rows).toEqual([
      { id: "other", name: "other", contextLength: 131072 },
      { id: "venice-uncensored-1-2", name: "venice-uncensored-1-2", contextLength: 32768 },
    ]);
  });

  it("prefers context_window when both spellings are present", () => {
    const rows = FILTERS.openai([{ id: "x", context_window: 200000, context_length: 128000 }]);

    expect(rows[0].contextLength).toBe(200000);
  });

  it("ignores a non-numeric context_window instead of emitting NaN", () => {
    const rows = FILTERS.openai([{ id: "x", context_window: "lots" }]);

    expect(rows[0].contextLength).toBeUndefined();
  });

  it("sorts by id so the list is stable across fetches", () => {
    const rows = FILTERS.openai([{ id: "zeta" }, { id: "alpha" }, { id: "mid" }]);

    expect(rows.map((r) => r.id)).toEqual(["alpha", "mid", "zeta"]);
  });
});
