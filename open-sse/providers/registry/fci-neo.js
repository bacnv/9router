export default {
  id: "fci-neo",
  alias: "fcineo",
  aliases: ["fpt-neo", "fpt-token"],
  uiAlias: "fn",
  display: {
    name: "FPT Token API",
    icon: "cloud",
    color: "#F58220",
    textIcon: "FN",
    website: "https://token-api.fpt.ai",
    notice: {
      apiKeyUrl: "https://token-api.fpt.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://token-api.fpt.ai/v1/chat/completions",
    // Multi-vendor gateway on an OpenAI-compatible wire: routing a Claude/Gemini/
    // GLM-named model through its family's native thinking format would send
    // fields this upstream rejects (enable_thinking, generationConfig, thinking).
    // Pinning the wire here outranks the per-model capability table.
    thinkingFormat: "openai",
  },
  models: [
    { id: "Qwen3.6-27B", name: "Qwen 3.6 27B" },
    { id: "Qwen3.8-27B", name: "Qwen 3.8 27B" },
    { id: "Alibaba:Qwen3.8-Max", name: "Qwen 3.8 Max" },
    { id: "Alibaba:Qwen3.8-Omni-Flash", name: "Qwen 3.8 Omni Flash" },
    { id: "Qwen2.5-VL-7B-Instruct", name: "Qwen 2.5 VL 7B Instruct" },
    { id: "Alibaba:DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash" },
    { id: "Alibaba:Deepseek-V4-Pro-0813", name: "DeepSeek V4 Pro" },
    { id: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" },
    { id: "Alibaba:Kimi-K3", name: "Kimi K3" },
    { id: "Minimax:Minimax-M3", name: "MiniMax M3" },
    { id: "GLM-5.2", name: "GLM 5.2" },
    { id: "Z.ai:GLM-5.2", name: "GLM 5.2 (Z.ai)" },
    { id: "Z.ai:GLM-5.3", name: "GLM 5.3" },
    { id: "Z.ai:GLM-5.3-Flash", name: "GLM 5.3 Flash" },
    { id: "Google:Gemini-3.1-Pro-Preview-Custom-Tool", name: "Gemini 3.1 Pro Preview" },
    { id: "Google:Gemini-3.5-Flash", name: "Gemini 3.5 Flash" },
    { id: "Azure:gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "Azure:gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "Azure:gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "Azure:gpt-4.1-nano", name: "GPT-4.1 Nano" },
    { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
    { id: "Llama-3.3-70B-Instruct", name: "Llama 3.3 70B Instruct" },
    { id: "gemma-3-27b-it", name: "Gemma 3 27B" },
    { id: "gemma-4-26B-A4B-it", name: "Gemma 4 26B A4B" },
    { id: "gemma-4-31B-it", name: "Gemma 4 31B" },
  ],
};
