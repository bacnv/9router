import { describe, expect, it } from "vitest";

import { capabilitiesFromServiceKind, getCapabilitiesForModel, setCustomModelCapabilities } from "../../open-sse/providers/capabilities.js";

describe("capabilitiesFromServiceKind", () => {
  it("maps imageToText custom models to vision-capable runtime models", () => {
    expect(capabilitiesFromServiceKind("imageToText")).toMatchObject({ vision: true });
  });

  it("maps media output/input custom model kinds to runtime capabilities", () => {
    expect(capabilitiesFromServiceKind("image")).toMatchObject({ imageOutput: true });
    expect(capabilitiesFromServiceKind("stt")).toMatchObject({ audioInput: true });
    expect(capabilitiesFromServiceKind("tts")).toMatchObject({ audioOutput: true });
  });

  it("merges registered custom capabilities over inferred model capabilities", () => {
    setCustomModelCapabilities([{ providerAlias: "ollama", id: "private-model", capabilities: { vision: true } }]);
    expect(getCapabilitiesForModel("ollama", "private-model")).toMatchObject({ vision: true, tools: true });
    setCustomModelCapabilities([]);
  });
});
