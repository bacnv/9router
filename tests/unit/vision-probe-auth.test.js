import { describe, expect, it } from "vitest";
import { isAuthorizedVisionProbe } from "../../src/sse/services/visionProbe.js";

describe("vision probe authorization", () => {
  const body = { metadata: { vision_probe: true } };

  it("accepts the matching internal token", () => {
    expect(isAuthorizedVisionProbe(body, { "x-9r-vision-probe": "secret" }, "secret")).toBe(true);
  });

  it("rejects missing or spoofed probe markers", () => {
    expect(isAuthorizedVisionProbe(body, {}, "secret")).toBe(false);
    expect(isAuthorizedVisionProbe(body, { "x-9r-vision-probe": "wrong" }, "secret")).toBe(false);
    expect(isAuthorizedVisionProbe({}, { "x-9r-vision-probe": "secret" }, "secret")).toBe(false);
  });
});
