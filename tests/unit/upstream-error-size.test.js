import { describe, expect, it } from "vitest";

import { parseUpstreamError } from "../../open-sse/utils/error.js";

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const CUSTOM_PROVIDER = "openai-compatible-chat-abc123";

describe("upstream error size limits", () => {
  it("preserves ordinary upstream error messages", async () => {
    const result = await parseUpstreamError(
      Response.json({ error: { message: "invalid image" } }, { status: 400 }),
      null,
      CUSTOM_PROVIDER,
    );

    expect(result).toEqual({ statusCode: 400, message: "invalid image" });
  });

  it("stops reading an oversized error body from a custom provider", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array(4096).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await parseUpstreamError(new Response(body, { status: 400 }), null, CUSTOM_PROVIDER);

    expect(result.statusCode).toBe(400);
    expect(result.message).toMatch(/exceeded.*64 KiB.*truncated/i);
    expect(new TextEncoder().encode(result.message).byteLength).toBeLessThan(256);
    expect(cancelled).toBe(true);
  });

  it("does not wait for more data after reaching the limit", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ERROR_BODY_BYTES).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await parseUpstreamError(new Response(body, { status: 400 }), null, CUSTOM_PROVIDER);

    expect(result.statusCode).toBe(400);
    expect(result.message).toMatch(/exceeded.*64 KiB.*truncated/i);
    expect(cancelled).toBe(true);
  });

  it("reads menu provider error bodies in full", async () => {
    const size = 300 * 1024;
    const body = new ReadableStream({
      start(controller) {
        for (let sent = 0; sent < size; sent += 4096) {
          controller.enqueue(new Uint8Array(Math.min(4096, size - sent)).fill(120));
        }
        controller.close();
      },
    });

    const result = await parseUpstreamError(new Response(body, { status: 400 }), null, "openai");

    expect(result.statusCode).toBe(400);
    expect(new TextEncoder().encode(result.message).byteLength).toBe(size);
    expect(result.message).not.toMatch(/truncated/i);
  });
});
