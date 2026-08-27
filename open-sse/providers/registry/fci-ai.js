export default {
  id: "fci-ai",
  alias: "fci",
  aliases: ["fpt-ai", "fptcloud"],
  uiAlias: "fci",
  display: {
    name: "FCI AI",
    icon: "cloud",
    color: "#F58220",
    textIcon: "FCI",
    website: "https://marketplace.fptcloud.com",
    notice: {
      apiKeyUrl: "https://marketplace.fptcloud.com",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://mkp-api.fptcloud.com/chat/completions",
  },
  models: [
    { id: "GLM-5.2", name: "GLM 5.2" },
    { id: "Qwen3.8-27B", name: "Qwen 3.8 27B" },
  ],
};
