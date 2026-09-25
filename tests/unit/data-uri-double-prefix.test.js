import { describe, expect, it } from "vitest";

import { encodeDataUri, parseDataUri } from "../../open-sse/translator/concerns/image.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";

const RAW_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";
const DATA_URL = `data:image/png;base64,${RAW_BASE64}`;

const imageMessage = (data) => ({
  max_tokens: 100,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
      ],
    },
  ],
});

describe("data URI encoding", () => {
  it("encodes raw base64 into a single data URI", () => {
    expect(encodeDataUri("image/png", RAW_BASE64)).toBe(DATA_URL);
  });

  it("leaves an existing data URI untouched", () => {
    expect(encodeDataUri("image/png", DATA_URL)).toBe(DATA_URL);
  });

  it("keeps every encoded result a single valid data URI", () => {
    const encoded = encodeDataUri("image/png", DATA_URL);

    expect((encoded.match(/data:/g) || []).length).toBe(1);
    expect(parseDataUri(encoded).base64).toBe(RAW_BASE64);
  });
});

describe("claude image blocks reaching an OpenAI provider", () => {
  it("does not double-prefix a data URL in a normal image block", () => {
    const result = claudeToOpenAIRequest("gpt-4o", imageMessage(DATA_URL), false);

    expect(result.messages[0].content[1].image_url.url).toBe(DATA_URL);
  });

  it("does not double-prefix a data URL in a tool_result image block", () => {
    const body = {
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: DATA_URL } },
              ],
            },
          ],
        },
      ],
    };

    const result = claudeToOpenAIRequest("gpt-4o", body, false);
    const imagePart = result.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p) => p.type === "image_url");

    expect(imagePart.image_url.url).toBe(DATA_URL);
  });

  it("still encodes raw base64 from an image block", () => {
    const result = claudeToOpenAIRequest("gpt-4o", imageMessage(RAW_BASE64), false);

    expect(result.messages[0].content[1].image_url.url).toBe(DATA_URL);
  });
});
