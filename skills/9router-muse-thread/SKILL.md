---
name: 9router-muse-thread
description: Keep a muse.ai design consistent across follow-up image and video renders by continuing one 9Router muse-web thread with `thread_id`. Use when the user wants to iterate on an existing image/video ("same design but blue", "animate that", "keep the layout"), needs several renders of the same subject, or is building a project where a visual identity must stay identical across assets.
---

# 9Router — Muse Thread Continuity (design memory)

Requires `NINEROUTER_URL` (and `NINEROUTER_KEY` if auth enabled). See https://raw.githubusercontent.com/bacnv/9router/refs/heads/merge/v0.5.109-fci-ai/skills/9router/SKILL.md for setup.

Requires a **muse-web** connection in the 9Router dashboard (muse.ai cookies — `hatch_sess` at minimum). Models: `muse-web/muse-image`, `muse-web/muse-video`.

## The idea

muse.ai's agent keeps the conversation's memory. Renders made in **the same thread** see each other, so a follow-up like *"make that circle blue, keep everything else identical"* actually works — the agent still has the first image. Renders in **different threads** start from nothing and only share whatever you put in the prompt.

9Router does not store threads. Each response **echoes back a `thread_id`**; you keep it and send it on the next call. Omitting it starts a fresh conversation.

## Endpoints

| Action | Endpoint |
|---|---|
| Image | `POST $NINEROUTER_URL/v1/images/generations` |
| Video (text-to-video) | `POST $NINEROUTER_URL/v1/videos/generations` |
| Video (image-to-video) | `POST $NINEROUTER_URL/v1/videos/edits` |

Both accept `thread_id` and return it.

| Field | Direction | Notes |
|---|---|---|
| `thread_id` | request | continue this conversation. Omit → new thread |
| `thread_id` | response | the thread the render landed in — persist it |

A dead or malformed `thread_id` never fails the request: 9Router falls back to a new thread and returns the new id. Always read `thread_id` from the **response**, not from what you sent.

## The loop

```bash
# 1. first render — no thread_id
THREAD=$(curl -s -X POST "$NINEROUTER_URL/v1/images/generations" \
  -H "Authorization: Bearer $NINEROUTER_KEY" -H "Content-Type: application/json" \
  -d '{"model":"muse-web/muse-image","prompt":"a single red circle centered on white, flat vector"}' \
  | jq -r '.thread_id')

# 2. same design, changed — pass the id back
curl -s -X POST "$NINEROUTER_URL/v1/images/generations" \
  -H "Authorization: Bearer $NINEROUTER_KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"muse-web/muse-image\",\"thread_id\":\"$THREAD\",\"prompt\":\"now that same circle in blue, everything else identical\"}"

# 3. animate it — images and video share one thread
curl -s -X POST "$NINEROUTER_URL/v1/videos/generations" \
  -H "Authorization: Bearer $NINEROUTER_KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"muse-web/muse-video\",\"thread_id\":\"$THREAD\",\"prompt\":\"animate that blue circle, 4 seconds, composition unchanged\"}"
```

Verified end-to-end: one thread produced a red circle (`RGB(253,23,22)`), then the same circle in blue (`RGB(20,99,187)`, identical pixel count within 0.2%), then a 4-second video keeping the blue (`RGB(13,97,193)`).

## Where to keep the id

The id is ordinary state — put it wherever your harness already keeps session data:

- a project/asset record (e.g. `projects.<slug>.thread_id`)
- a per-user row in your DB
- a JSON file next to the generated assets
- a conversation/session variable

One thread per **design**, not per user: a project with two visual identities wants two ids. Reusing one id for unrelated renders drags unrelated context along and makes the agent confuse subjects.

## Prompting for continuity

The thread supplies the memory; the prompt still has to say what to keep.

| Do | Don't |
|---|---|
| "same circle in blue, everything else identical" | "a blue circle" |
| "animate that exact composition" | "a video of a circle" |
| "keep the layout, change only the typography" | "make a poster" |
| one change per turn | several changes at once |

## Growing threads

A thread accumulates every turn. Long threads make renders slower and more expensive, and eventually the agent loses the earlier detail it is supposed to preserve. When a design is settled, **start a new thread seeded from the finished asset** — send the final image with `images[]` (image-to-video/edits) or an edit-mode image call, and continue from there. Treat a thread as one working session, roughly a few dozen turns, not a permanent record.

## Response shape

Image:

```json
{ "created": 1735000000, "thread_id": "f0c3c34a-4b42-4a39-a787-637f48458fc0",
  "data": [{ "b64_json": "UklGR..." }] }
```

Video:

```json
{ "id": "video-muse-web-1735000000", "object": "video.generation", "status": "completed",
  "thread_id": "f0c3c34a-4b42-4a39-a787-637f48458fc0",
  "video": { "url": "data:video/mp4;base64,...", "width": 960, "height": 960 } }
```

`thread_id` is present only for providers that keep conversations (currently `muse-web`). Treat a missing field as "this provider has no memory" and do not send it on the next call.

## Limits

- **One connection, one browser.** Concurrent renders on the same thread serialize; queue them or use separate threads.
- **Provider-specific.** Other providers ignore `thread_id` and return none — no error, just no memory.
- **Not a file store.** The thread holds conversation context, not the generated assets. Download and keep the bytes you care about; the thread can be pruned upstream.

## Errors

- 502 with `No Chrome/Chromium executable found` → Login-via-browser needs a real browser; that host cannot run muse-web. Use a host with Chrome.
- 400 `Missing hatch_sess cookie` → the muse-web connection's cookies expired; re-login in the dashboard.
- 502 `muse.ai session rejected` → cookies invalid; re-login.
