import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_SALT = "9r-cli-auth";

function createSilentWavFile() {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const durationMs = 250;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([buffer], { type: "audio/wav" });
}

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    apiKey = keys.find((k) => k.isActive !== false)?.key || null;
  } catch {}

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

const VISION_CHALLENGE = "9R7K2M";
const VISION_CHALLENGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAeAAAAB4CAIAAACl9LZYAAAMuUlEQVR42u3de1BU5R/HcZbLgiKiiGmKyNVGZ5zQSEvMCzWjaTcNIy4VmGRljaEwCOaly4BYE/7hyEwsZOiME6KhEyECiQZ4KSVkHCjI2AylAiFIYlmX/f2xDZ2eA8vZXS378X79xX55nnPOntn58OxzznlQGY1GOwDAnceeUwAABDQAgIAGAAIaAEBAAwABDQAgoAEABDQAENAAAAIaAAhoAAABDQAgoAGAgAYAENAAQEADAAhoACCgAQAENACAgAYAAhoAQEADAAENACCgAQAENAAQ0AAAAhoACGgAAAENAAQ0AICABgAQ0ABAQAMACGgAIKABAAQ0AICABgACGgBAQAMAAQ0AIKABgIAGANyRHG/r1o1GY2Fh4dGjRysrK1taWn7//XdPT88JEyaEhISsWLFi8eLFKpVq2J76rq6uoqKi8vLy8+fPa7Xa9vZ2JyensWPH+vv7z5079+mnn54zZw4fUGBYM442Fy9eDA4ONrPreffmXbp0abDumZmZg3V0dnb29PQMCAhYvnz5pk2bKisr+/r6BtvOvn37rDszv/76q3Q7S5YskSfsgHs8fPiw/IDPnDnT36CsrCwsLEytVps/gDlz5lRXVw+4i08//VTe/rHHHpO3DA8Pl7fMzMw0Arjj3a6A/vLLL93d3YcMwZEjR549e9bSgJYLDAw8duzYnRDQdXV1bm5uQsvs7Oz+Bj/88IPyY3Byctq/f7/CgHZ1ddXpdNJmBoNh3LhxBDTwH3Vb5qBbW1tXrVr122+/Ddmyu7t7+fLlV65csXGPDQ0NS5cu3b17978+a7FixYquri5pcd26datXr7Zug3q9/oUXXigtLVXS+MaNGxUVFdLK119/3dbWxtdE4D/qtgT05s2bW1palKd5YmLiLdnv+vXrz5w58y+ezZiYmPr6emllwYIFGRkZtmzTYDC8+uqrer1eSeNjx46ZeQlguAd0e3u7fFZhw4YNDQ0NOp3u8uXLSUlJwrXBgwcPNjU12b7rvr6+bdu23ZJ34eXlNXbsWIu6pKWlCbPP3t7e+fn5Tk5OA7Z3d3ePiorSaDQ1NTVtbW16vb65ufnjjz/28/OTfz84ceKEkmMoLi428xLAf8wtnzQ5cOCAsIuUlBShzZYtW4Q2qampQ85B79u3z/QrnU6n1WpzcnK8vLyENg4ODp2dnZYes0ajEbazdetWoY35Oejjx4/b2//tr92IESPOnz8v31dTU1NoaOihQ4d6e3sHPJi2tjZ/f39hXwkJCWbmoB0d/7obp7m52dSmo6PDwcFB3sCOOWhg2M5Bnz59WsippKQkoU1iYuKIESOs/jKuVqu9vb1jY2PLy8udnZ2FCQErZjmysrL+9rXC3v7FF19U3l2r1UZERPT19QnbnD17trzx1KlTy8rKVq5cOdjI2sPD48033xSKP/30k5kDuO++++Sj5tLSUoPBIG8AYPhOcTQ0NEhfzp49e/To0UIbNzc3IbzOnTvXnybK+fv7ywe2165ds2gjtbW1Z8+elVaWLFni7e2tsHtPT8/KlSuFa3EbN26Mioqy+hw+8MAD8r2YaR8QEND/ZaI/oPv/5o0aNcr8/Y4AhtEctPTlpEmTBmwm1Ht6ehobG63YXWBgoFDp6OiwaAsffvihUImLi1Pe/ZVXXrlw4YK08sgjj6Snp9tyDoXBuJ2d3fjx4813Wbx4semHkpISU/fjx4+bKiEhIcIUB4BhGtDCWM9oNCrMIItuEDazfWHyZMij3b9/v7QyceLExx9/XGH3PXv27N27V1rx8/P75JNP+id/rVNTUyNUhhwCL1q0yPTD9evXv/rqq7q6uh9//NFUWbhwIR90gID+c/pC+vLq1asDNpNPRDQ3N1uxu2+//Vao+Pj4KO+el5cnjLhjY2MVjjdPnz4dHx8vrbi6uhYUFHh4eNh4DrOzs6UvHR0dly1bpnAEbZrckN6/0Z/dAIZ7QHt6ekpfXrhwQf7ESldXV3V1tfm5EYXp3P9F3sTFxcWiJSyEy4MqlWrNmjUK+0ZGRvb29kora9eunTlzpo0n8LPPPisrK5NWoqKi5PerCHx9fadOnWr6ubi4uH8C2tXVlQlogID+U1BQkDCHkJaWJrR57733/vjjD6F448YNhbvQ6/VarVaj0YSGhgpPcERHRyt5xNykvr5eePTu4Ycflt+GPJjW1lahkpub29nZacvZa2lpWbt2rbQyevTod955R0nf/pHyuXPnTp48afp53rx5g90uAmDYBfSCBQuESnp6+oYNG77//nu9Xt/U1JScnPzuu+/KOwqjUbnnnntOpVKpVCq1Wu3j4xMXFyfMn/j4+OzYsUP5ocovD7700ku2vPfW1tadO3da3V2n04WFhQlvKiMjY8qUKUq6989yGAyG/isBzG8ABPRfFi5cKH/OIiMjIyAgQK1W+/r67tixY8ArhzYO9B566KGTJ08OuDbQgHp7e3Nzc6WV8ePHP/nkkza+/YyMDEvv8zPp6+uLjo6urKyUFuPi4pSv4yGdhpYPqwEQ0HYqlertt9+2oqN8ETglHBwc1qxZc+rUqVOnTim/ednOzu7w4cPCzcsxMTFDLgE6pO7u7u3bt1vR8eWXX87Pz5dWnnjiCYuW9PP29vb19ZVWRo4cef/99/MpBwjov0RGRsbExJhvM2XKFFdXV2lF/jyLEgaDIT8/34qHXGy8/dnExcXl4MGDQqxnZ2cLSyYNKSkpSbhcGRoaasXtesIgmglogIAeQHZ2dmJi4mD3q02bNq24uFiYdLb67rSOjo7w8HCLbgJpbGwsLy8XpgLkz7wMKTMzMywsTJi5NhgMycnJyjeSlpYmzFw/+OCDR44ccXFxsfR4hIBmfgMgoAfarr39zp07a2trExISgoKCPDw8nJyc7r777tDQ0N27d1+8eNHNzU24AWPGjBnmt2laLKm9vT0rK0sYbv/yyy8Kb3Uw0Wg0wjy4FZcH161bZ/qisGXLFuHbQEFBQVVVlZKN7NmzJyUlRVoJDg4uKioaNWqUFac9OjpautLK5s2b+YgD/2H/1ipNeXl5wlzBzZs3Fa5mZzQaT5w4IQzPnZ2dr1y5omTXvb29EyZMkPYdN25cT0+P+V7yRT86OjrMRGFISMiQR5KbmyusvBoUFHT9+vUhOwqr2UVFRZlvv379emHgzzphwDD9jypKCGtG33vvvRbNty5atOi1116TVnQ63VtvvaWk79GjR3/++Wdp5fnnnxdWxVNCesCJiYnCFE1lZeWRI0fMdC8oKIiNjZUO5GfOnFlSUmLpOtQAmOK4lSoqKgoLC6WVVatWWbqRbdu2Cc+k7N2797vvvhuyo3A5zs6qy4MCd3f3TZs2CcXk5OTBrl6WlJQ8++yz0t/OmDGjtLRUeA4TAAH9j7p06VJ4eLh0sSR7e/uIiAhLtzNmzBjhm/vNmze3bt1qvpdWqy0pKZFW5s+fP336dNvf1+uvvz558mRppa6uLicnR96yqqrqqaee0ul0/ZVp06aVlZXdddddfCIB3N6A1ul006dP37hx46FDh2pqaq5du6bX69vb26uqquLj44ODg4WH5SIiIgZbldS8+Ph4YRCdl5f3zTffmOmi0WiEhfRsHz6buLi4yP88bN++vbu7W1qprq5etmyZtOjn5/fFF19MnDiRjyOA2x7QRqOxvr7+gw8+CAsLCwoKmjRpklqt9vDwCAkJ2bVrl7Aeqbu7+/vvv2/djuSDaKPRKNwUIWUwGD766CNhC1bMrgxm9erVwr16V69e3bVrl7SSkJAgrB51+fJlLy8vlVnz58/nwwoQ0P8oR0dHjUZjy+BRPoguKioSlkDqV1hYKCxqGh0dbdH60UO+Hfndfunp6dJllax4pgYAAf1Pc3JyOnDgQFhYmC0bkQ+i7ezsBntORH550MbVkeSeeeaZWbNmSSudnZ0DLg4FAHdoQD/66KO1tbU2pvNgg+iKioqioiKhWXNzs1CcO3eu7cs3C1QqVWpqqlDMzMy07v/FACCgbzEXF5fGxsasrKzIyMhZs2ZNnjxZrVa7u7sHBgaGhoampqbW1tZ+/vnn99xzzy3Z3ZgxY9544w2hmJKSIjwrmJOTI0wv3PLhs8nSpUuFZ6x7e3t5qA+AxQO+wf5nIADg/2HEDQAgoAGAgAYAENAAAAIaAAhoAAABDQAENACAgAYAAhoQ0AAAAhoAQEADAAENACCgAYCABgAQ0ABAQAMACGgAAAENAAQ0AICABgACGgBAQAMACGgAIKABAAQ0ABDQAAACGgAIaAAAAQ0AIKABgIAGABDQAEBAAwAIaAAAAQ0ABDQAgIAGAAIaAEBAAwAIaAC4Y/0P2LbQ4ZnSQ1wAAAAASUVORK5CYII=";

export async function probeVisionCapability(model, baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`, challenge = VISION_CHALLENGE) {
  const headers = await getInternalHeaders();
  headers["x-9r-vision-probe"] = await getConsistentMachineId("9r-vision-probe");
  try {
    const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 64,
        stream: false,
        metadata: { vision_probe: true },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Return only the exact code shown in this image." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${VISION_CHALLENGE_PNG}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { vision: null };
    const parsed = JSON.parse(await res.text());
    const content = parsed?.choices?.[0]?.message?.content;
    return { vision: typeof content === "string" && content.includes(challenge) ? true : null };
  } catch {
    return { vision: null };
  }
}

export async function pingModelByKind(model, kind, baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`) {
  const headers = await getInternalHeaders();
  const start = Date.now();

  if (kind === "embedding") {
    const res = await fetch(`${baseUrl}/api/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: "test" }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }
    const hasEmbedding = Array.isArray(parsed?.data) && parsed.data.length > 0 && Array.isArray(parsed.data[0]?.embedding);
    if (!hasEmbedding) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no embedding data" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "image") {
    const res = await fetch(`${baseUrl}/api/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: "test" }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const hasImages = Array.isArray(parsed?.data) && parsed.data.length > 0;
    if (!hasImages) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no image data for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "stt") {
    const form = new FormData();
    const sampleAudio = createSilentWavFile();
    form.append("file", sampleAudio, "test.wav");
    form.append("model", model);

    const res = await fetch(`${baseUrl}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")),
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const text = typeof parsed?.text === "string" ? parsed.text : "";
    if (!text.trim()) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no transcription text for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      // 1024 tokens: reasoning models (ClinePass/kimi-k3, deepseek-v4-pro, etc.) spend
      // their budget on chain-of-thought before emitting an answer. A tiny probe like
      // max_tokens:16 starves the answer and yields a false "no choices" failure.
      // See issue #3010.
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  const latencyMs = Date.now() - start;

  const rawText = await res.text().catch(() => "");
  let parsed = null;
  try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

  if (!res.ok) {
    const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
    return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
  }

  const providerStatus = parsed?.status;
  const providerMsg = parsed?.msg || parsed?.message;
  const hasProviderErrorStatus = providerStatus !== undefined
    && providerStatus !== null
    && String(providerStatus) !== "200"
    && String(providerStatus) !== "0";
  if (hasProviderErrorStatus && providerMsg) {
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: `Provider status ${providerStatus}: ${String(providerMsg).slice(0, 240)}`,
    };
  }

  if (parsed?.error) {
    const providerError = parsed?.error?.message || parsed?.error || "Provider returned an error";
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: String(providerError).slice(0, 240),
    };
  }

  const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length > 0;

  // Soft-pass (issue #3010): a reasoning model may burn its whole budget on
  // chain-of-thought and return finish_reason:"length" with empty content but
  // non-empty reasoning/thinking. That's a successful connection, not a failure.
  const firstChoice = parsed?.choices?.[0] || {};
  const hasReasoning =
    firstChoice.message?.reasoning ||
    firstChoice.message?.reasoning_content ||
    firstChoice.message?.thinking ||
    firstChoice.message?.thinking_content;
  const contentEmpty = !String(firstChoice.message?.content || "").trim();
  if (hasChoices && firstChoice.finish_reason === "length" && contentEmpty && hasReasoning) {
    return { ok: true, latencyMs, error: null, status: res.status, note: "reasoning-only response (length-limited)" };
  }

  if (!hasChoices) {
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: "Provider returned no completion choices for this model",
    };
  }

  return { ok: true, latencyMs, error: null, status: res.status };
}
