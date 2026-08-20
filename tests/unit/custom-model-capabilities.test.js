import { describe, expect, it, vi } from "vitest";
import { detectCustomModelCapabilities } from "../../src/app/api/models/custom/capabilities.js";

describe("custom model capability detection", () => {
  it("adds detected vision support before persistence", async () => {
    const probe = vi.fn(async () => ({ vision: true }));
    await expect(detectCustomModelCapabilities("custom/model", { vision: false }, probe))
      .resolves.toEqual({ vision: true });
  });

  it("preserves a manual vision selection without probing", async () => {
    const probe = vi.fn();
    await expect(detectCustomModelCapabilities("custom/model", { vision: true }, probe))
      .resolves.toEqual({ vision: true });
    expect(probe).not.toHaveBeenCalled();
  });

  it("preserves the submitted value when detection is inconclusive", async () => {
    const probe = vi.fn(async () => ({ vision: null }));
    await expect(detectCustomModelCapabilities("custom/model", { vision: false }, probe))
      .resolves.toEqual({ vision: false });
  });
});
