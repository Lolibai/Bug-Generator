# Local Whisper Dictation — Design

**Date:** 2026-07-03
**Status:** Approved (Option A — faster-whisper sidecar container)

## Goal

A third dictation mode, **Local Whisper**, that transcribes daily Ukrainian
(and English) dictation on the team's own hardware — no cloud keys, no
per-minute cost. Python lives only in a dedicated whisper container; the
Express backend proxies to it; the frontend treats it like the existing
GPT-4o Transcribe mode.

Host hardware: RTX 3060 Ti 8 GB / 20 cores / 62 GB RAM.

## Architecture

```
browser (MediaRecorder blob)
  → Express  POST /api/transcribe        (multipart audio, language?, prompt?)
    → whisper container  POST /transcribe (FastAPI + faster-whisper, CUDA)
  ← { text }
```

- New `whisper/` directory: `Dockerfile` (python3.11-slim + faster-whisper +
  fastapi/uvicorn + python-multipart) and `app.py` (~50 lines).
- compose service `whisper`: CPU-safe by default (`WHISPER_DEVICE=auto`) so
  the base compose runs unchanged on MacBook Pros and other non-NVIDIA
  hosts; GPU passthrough is opt-in via `docker-compose.gpu.yml`
  (`COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env`,
  requires nvidia-container-toolkit). Model cache in named volume
  `whisper-models`; env `WHISPER_MODEL` (default `large-v3-turbo`; set
  `large-v3` for max accuracy). Healthcheck on `GET /healthz`. Not
  published to the host network — only the app service reaches it on the
  compose network (`http://whisper:9000`).

## Components

### 1. Whisper service (`whisper/app.py`)

- Loads the model once at startup (faster-whisper `WhisperModel`,
  `compute_type=int8_float16` on cuda / `int8` on cpu).
- `POST /transcribe` — multipart `file` (webm/ogg/wav — ffmpeg via
  faster-whisper handles containers), optional form fields `language`
  (`uk`/`en`/empty=auto) and `prompt` (glossary terms, passed as
  `initial_prompt`). Returns `{ "text": "...", "language": "uk",
  "duration": 12.3 }`. Segments joined with spaces, stripped.
- `GET /healthz` → `{ "ok": true, "model": "<name>", "device": "cuda" }`.
- Errors → JSON `{ "detail": ... }` with 4xx/5xx (FastAPI defaults).

### 2. Express proxy (`server/routes/transcribe.js`)

- `POST /api/transcribe` — streams the incoming multipart request through
  to `WHISPER_URL` (env, default `http://whisper:9000`) `/transcribe`;
  passes response through (status + JSON). 503 with
  `{ error: 'Whisper service unavailable' }` when the upstream is
  unreachable.
- `GET /api/transcribe/status` — proxies `/healthz`; on failure returns
  `{ ok: false }` with 200 (the UI uses this to show/hide the mode, it is
  not an error).
- Upstream calls go through the injectable `fetchImpl` for tests.

### 3. Frontend

- Setup → Dictation gains a third toggle option: **🏠 Local Whisper**
  (`cfg.voiceAiCleanup = 'local-whisper'`), rendered only when
  `GET <backend>/api/transcribe/status` reports `ok:true` (re-checked when
  the Setup page renders; uses `effectiveBackendUrl()`).
- Recording flow reuses the existing GPT-4o Transcribe path (MediaRecorder
  → blob) but POSTs to `<backend>/api/transcribe` with fields:
  `language` from the УК/EN toggle (`uk-UA`→`uk`, `en-US`→`en`),
  `prompt` = joined context-words glossary terms.
- Falls back with the existing error toast pattern if transcription fails;
  nothing recorded is lost (same guarantee the GPT-4o mode gives).

## Error handling

- Whisper container down → status endpoint hides the mode; an in-flight
  request gets the 503 toast.
- No GPU / toolkit missing → container still starts with
  `WHISPER_DEVICE=cpu` (README notes ~10–20 s per dictation on CPU).
- Oversized uploads: Express route caps audio at 25 MB (413).

## Testing

- Server: supertest with fake `fetchImpl` — proxy passthrough (status,
  JSON body, multipart forwarded), 503 on upstream failure, status
  endpoint's `{ok:false}` softening.
- Whisper container: `GET /healthz` smoke after `docker compose up`;
  manual dictation end-to-end (record in УК, verify transcript).
- No Python unit tests (app.py is a thin wrapper; the container healthcheck
  and E2E cover it).

## Out of scope (YAGNI)

- Streaming/live partial transcripts (batch only, like GPT-4o mode).
- Speaker diarization, word timestamps, translation.
- Auth between app and whisper containers (compose-network-internal only).
- Replacing/removing the Web Speech or GPT-4o modes.
