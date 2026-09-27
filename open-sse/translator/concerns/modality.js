// Strip multimodal content blocks a model cannot read, BEFORE translation.
// Driven by getCapabilitiesForModel: vision/audioInput/pdf. Replaces removed
// media with a short text placeholder so messages never become empty.
import { FORMATS } from "../formats.js";

// Same ceiling the other nested walkers in this repo use (capabilities.js, codex.js).
const MAX_NEST_DEPTH = 6;

// Placeholder text inserted where a media block was removed.
// Current turn: explain the active model can't read what the user just sent.
const PLACEHOLDER_CURRENT = {
  vision: "[image omitted: model has no vision support]",
  audioInput: "[audio omitted: model has no audio support]",
  pdf: "[file omitted: model has no document support]",
};
// Earlier turns: neutral (a combo may route to a different model each turn).
const PLACEHOLDER_PREV = {
  vision: "[Previous image omitted from context.]",
  audioInput: "[Previous audio omitted from context.]",
  pdf: "[Previous file omitted from context.]",
};
const ph = (cap, isLast) => (isLast ? PLACEHOLDER_CURRENT : PLACEHOLDER_PREV)[cap];

// Map gemini inlineData/fileData mime prefix -> capability it requires.
function capForMime(mime) {
  if (typeof mime !== "string") return null;
  if (mime.startsWith("image/")) return "vision";
  if (mime.startsWith("audio/")) return "audioInput";
  if (mime === "application/pdf") return "pdf";
  return null;
}

// OpenAI chat content block -> required capability (null = plain text/other, keep).
function capForOpenAIBlock(block) {
  const t = block?.type;
  if (t === "image_url" || t === "image") return "vision";
  if (t === "input_audio" || t === "audio_url") return "audioInput";
  if (t === "file") return "pdf";
  return null;
}

// Claude content block -> required capability.
function capForClaudeBlock(block) {
  const t = block?.type;
  if (t === "image") return "vision";
  if (t === "document") return "pdf";
  return null;
}

// Combo members share one source body, so every object this module rewrites is
// copied first: a strip for a text-only member must not remove media from a
// later member that can read it.
const fresh = (arr) => arr.map((x) => (x && typeof x === "object" ? { ...x } : x));

// Filter an array of content blocks; drop unsupported, inject one placeholder per kind.
// isLast = block belongs to the current user turn (picks the explanatory placeholder).
// depth bounds the descent into nested tool results — a body can nest arbitrarily
// (a JSON-encoded one survives transport), and unbounded recursion is a stack overflow.
function filterBlocks(blocks, capOf, caps, removed, isLast, depth = 0) {
  const out = [];
  for (const block of blocks) {
    const cap = capOf(block);
    if (cap && caps[cap] === false) { removed.add(cap); continue; }
    // A tool result nests its own blocks (Claude tool_result.content) — media a
    // tool returned must be stripped here too, or the data URI reaches an
    // upstream that cannot read it. A separate Set keeps the placeholder next
    // to what it replaces instead of adding a second copy at the top.
    if (depth < MAX_NEST_DEPTH && Array.isArray(block?.content)) {
      out.push({ ...block, content: filterBlocks(block.content, capOf, caps, new Set(), isLast, depth + 1) });
      continue;
    }
    out.push(block);
  }
  for (const cap of removed) out.push({ type: "text", text: ph(cap, isLast) });
  return out;
}

// OpenAI / OpenAI-compatible chat messages[].content[].
// Rewrites body.messages with fresh entries so a shared source body is not mutated.
function stripOpenAI(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  const messages = body.messages.map((msg, i) => {
    if (!msg || typeof msg !== "object") return msg;
    const out = { ...msg };
    if (caps.vision === false) {
      if (Array.isArray(out.images)) delete out.images;
      if (Array.isArray(out.experimental_attachments)) {
        out.experimental_attachments = out.experimental_attachments.filter(
          (a) => !(a?.contentType?.startsWith("image/") || (typeof a?.url === "string" && a.url.startsWith("data:image/")))
        );
      }
      if (Array.isArray(out.attachments)) {
        out.attachments = out.attachments.filter(
          (a) => !(a?.contentType?.startsWith("image/") || (typeof a?.url === "string" && a.url.startsWith("data:image/")))
        );
      }
    }
    if (!Array.isArray(out.content)) return out;
    const removed = new Set();
    out.content = filterBlocks(fresh(out.content), capForOpenAIBlock, caps, removed, i === last);
    return out;
  });
  body.messages = messages;
}

// Claude messages[].content[].
function stripClaude(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages = body.messages.map((msg, i) => {
    if (!msg || typeof msg !== "object") return msg;
    const out = { ...msg };
    if (!Array.isArray(out.content)) return out;
    const removed = new Set();
    out.content = filterBlocks(fresh(out.content), capForClaudeBlock, caps, removed, i === last);
    return out;
  });
}

// OpenAI Responses input[].content[] (input_image / input_file).
function stripResponses(body, caps) {
  if (!Array.isArray(body.input)) return;
  const last = body.input.length - 1;
  body.input = body.input.map((item, i) => {
    if (!item || typeof item !== "object") return item;
    const out = { ...item };
    if (!Array.isArray(out.content)) return out;
    const removed = new Set();
    out.content = out.content.filter((b) => {
      const cap = b?.type === "input_image" ? "vision" : b?.type === "input_file" ? "pdf" : null;
      if (cap && caps[cap] === false) { removed.add(cap); return false; }
      return true;
    });
    for (const cap of removed) out.content.push({ type: "input_text", text: ph(cap, i === last) });
    return out;
  });
}

// Gemini / gemini-cli contents[].parts[] (inlineData / fileData by mime).
function stripGeminiParts(contents, caps) {
  if (!Array.isArray(contents)) return null;
  const last = contents.length - 1;
  return contents.map((c, i) => {
    if (!c || typeof c !== "object") return c;
    const out = { ...c };
    if (!Array.isArray(out.parts)) return out;
    const removed = new Set();
    out.parts = out.parts.filter((p) => {
      const mime = p?.inlineData?.mimeType || p?.fileData?.mimeType;
      const cap = capForMime(mime);
      if (cap && caps[cap] === false) { removed.add(cap); return false; }
      return true;
    });
    for (const cap of removed) out.parts.push({ text: ph(cap, i === last) });
    return out;
  });
}

/**
 * Remove media blocks the model can't read, from the source-format body.
 * Copies the arrays/objects it rewrites (body itself is not replaced), so a
 * source body shared between combo members keeps its media for the members
 * that can read it.
 * @param {object} body - request body (source format)
 * @param {string} sourceFormat - one of FORMATS
 * @param {object} caps - capabilities from getCapabilitiesForModel
 * @returns {boolean} true if anything was stripped-eligible (cap false for some modality)
 */
export function stripUnsupportedModalities(body, sourceFormat, caps) {
  if (!body || !caps) return false;
  // Fast exit: model supports everything we'd strip.
  if (caps.vision !== false && caps.audioInput !== false && caps.pdf !== false) return false;

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      stripOpenAI(body, caps);
      break;
    case FORMATS.CLAUDE:
      stripClaude(body, caps);
      break;
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      stripResponses(body, caps);
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      if (Array.isArray(body.contents)) body.contents = stripGeminiParts(body.contents, caps);
      break;
    case FORMATS.ANTIGRAVITY:
      if (Array.isArray(body?.request?.contents)) {
        body.request = { ...body.request, contents: stripGeminiParts(body.request.contents, caps) };
      }
      break;
    default:
      stripOpenAI(body, caps);
  }
  return true;
}
