export default {
  id: "synthetic",
  alias: "syn",
  aliases: [
    "synthetic.new",
    "synthetic-new",
  ],
  uiAlias: "syn",
  display: {
    name: "Synthetic",
    icon: "smart_toy",
    color: "#3B0A45",
    textIcon: "SY",
    website: "https://synthetic.new",
    notice: {
      text: "Open-model subscription (DeepSeek, GLM, Qwen, Kimi, gpt-oss). Model ids need the hf: prefix; the syn:* aliases track the recommended models.",
      apiKeyUrl: "https://synthetic.new/user-settings/api",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.synthetic.new/v1/chat/completions",
    // /v1/models answers 200 for any Bearer, so only the quota call can tell a
    // bad key from a good one (401 "Invalid API Key." on both /v1 and /v2).
    validateUrl: "https://api.synthetic.new/v2/quotas",
    usage: { url: "https://api.synthetic.new/v2/quotas" },
    // reasoning_effort is the accepted effort spelling (verified live).
    thinkingFormat: "openai",
    quirks: {
      // The DeepSeek-backed ids (and the syn:* aliases, which resolve to them)
      // stream thinking as `reasoning`, not reasoning_content; GLM/Qwen/Kimi on
      // the same lane send reasoning_content. The lift is additive and a no-op
      // for the latter (see stream.js).
      reasoningAliasFields: true,
    },
  },
  // Catalogue from the unauthenticated GET /v1/models (2026-10-27): context,
  // output cap, modalities and per-model effort sets mirror that payload.
  // syn:* aliases are what Synthetic recommends (pinned ids 404 when rotated).
  // thinkingLevels are the payload's own `reasoning_parameters.efforts`; max on
  // the models that omit it is a hard 400 upstream, so the declared set is the
  // clamp the picker and thinkingUnified both need.
  models: [
    { id: "syn:large:text", name: "Syn Large Text (DeepSeek V4.1 Flash)", thinkingLevels: ["none", "low", "high", "xhigh", "max"] },
    { id: "syn:small:text", name: "Syn Small Text (GLM 4.7 Flash)", thinkingLevels: ["none", "low", "medium", "high"] },
    { id: "syn:large:vision", name: "Syn Large Vision (Kimi K3)", thinkingLevels: ["low", "high", "max"] },
    { id: "syn:small:vision", name: "Syn Small Vision (DeepSeek V4.1 Flash)", thinkingLevels: ["none", "low", "high", "xhigh", "max"] },
    { id: "hf:deepseek-ai/DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash", thinkingLevels: ["none", "low", "high", "xhigh", "max"] },
    { id: "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DeepSeek V4.1 Flash 10/17", thinkingLevels: ["none", "low", "high", "xhigh", "max"] },
    { id: "hf:zai-org/GLM-5.3", name: "GLM 5.3", thinkingLevels: ["low", "high", "max"] },
    { id: "hf:zai-org/GLM-5.3-Flash", name: "GLM 5.3 Flash", thinkingLevels: ["low", "high", "max"] },
    { id: "hf:zai-org/GLM-4.7-Flash", name: "GLM 4.7 Flash", thinkingLevels: ["none", "low", "medium", "high"] },
    { id: "hf:moonshotai/Kimi-K3", name: "Kimi K3", thinkingLevels: ["low", "high", "max"] },
    { id: "hf:Qwen/Qwen3.8-27B", name: "Qwen 3.8 27B", thinkingLevels: ["low", "medium", "xhigh"] },
    { id: "hf:openai/gpt-oss-120b", name: "GPT-OSS-120B", thinkingLevels: ["none", "low", "medium", "high"] },
    { id: "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4", name: "Nemotron 3 Super 120B", thinkingLevels: ["none", "low", "medium", "high"] },
  ],
  serviceKinds: ["llm", "embedding"],
  // Embeddings are free and excluded from the request quota (/docs/api/models).
  embeddingConfig: {
    baseUrl: "https://api.synthetic.new/v1/embeddings",
    authType: "apikey",
    authHeader: "bearer",
    models: [{ id: "hf:nomic-ai/nomic-embed-text-v1.5", name: "Nomic Embed Text v1.5" }],
  },
  // The always-on list above is the whole catalogue today, but Synthetic asks
  // clients to pin aliases and can add models without a release, so keep the
  // live list in the picker. The family fallback in providerModels.js keeps
  // unknown ids on the OpenAI chat lane.
  modelsFetcher: { url: "https://api.synthetic.new/v1/models", type: "openai" },
  passthroughModels: true,
  features: {
    usage: true,
    usageApikey: true,
  },
};
