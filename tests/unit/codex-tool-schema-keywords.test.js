// Codex's strict-schema compiler rejects some JSON Schema keywords outright.
// A tool carrying `propertyNames` answers, on every account:
//
//   400 invalid_json_schema — Invalid schema for 'tools[2].parameters':
//   Unimplemented keys: ["propertyNames"]
//
// The request is deterministically malformed for this provider, so the combo
// pays a full failover for something no Codex account could ever accept.

import { describe, expect, it } from "vitest";
import { stripCodexUnsupportedPatterns } from "../../open-sse/utils/codexToolSchema.js";

const strip = (schema) => {
  const stats = { removed: 0 };
  return { out: stripCodexUnsupportedPatterns(structuredClone(schema), stats), stats };
};

describe("codex tool schema: unimplemented keywords", () => {
  it("drops propertyNames at the top level", () => {
    const { out, stats } = strip({
      type: "object",
      propertyNames: { pattern: "^[a-z]+$" },
      properties: { a: { type: "string" } },
    });
    expect(out).toEqual({ type: "object", properties: { a: { type: "string" } } });
    expect(stats.removed).toBe(1);
  });

  it("drops it wherever it is nested", () => {
    const { out, stats } = strip({
      type: "object",
      properties: {
        b: { type: "object", propertyNames: { type: "string" }, properties: { c: { type: "number" } } },
      },
      not: { propertyNames: { type: "string" } },
    });
    expect(out).toEqual({
      type: "object",
      properties: { b: { type: "object", properties: { c: { type: "number" } } } },
      not: {},
    });
    expect(stats.removed).toBe(2);
  });

  it("leaves every other keyword untouched", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string", enum: ["x", "y"] } },
      required: ["a"],
      additionalProperties: false,
      oneOf: [{ properties: { a: { const: "x" } } }],
      // A valid pattern (no \p{...}) must survive byte-identical.
      patternProperties: { "^a": { type: "string" } },
    };
    const { out, stats } = strip(schema);
    expect(out).toEqual(schema);
    expect(stats.removed).toBe(0);
  });

  it("does not mistake a property NAME for a keyword", () => {
    // `properties` keys are arbitrary names, never schema keywords.
    const schema = {
      type: "object",
      properties: { propertyNames: { type: "string" }, pattern: { type: "string" } },
    };
    const { out } = strip(schema);
    expect(out).toEqual(schema);
  });
});
