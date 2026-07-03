# Local Whisper Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third dictation mode, Local Whisper, transcribing on the team's own GPU via a Python faster-whisper container, proxied through the Express backend.

**Architecture:** New `whisper/` container (FastAPI + faster-whisper, `large-v3-turbo` default, CUDA int8_float16) reachable only on the compose network; Express gains `POST /api/transcribe` (multipart passthrough) and `GET /api/transcribe/status`; the frontend adds a `local-whisper` value to `cfg.voiceAiCleanup` and a `transcribeAudio()` dispatcher over the existing GPT-4o record-then-transcribe flow.

**Tech Stack:** python3.11-slim, faster-whisper, fastapi, uvicorn, python-multipart; Node 20 undici streaming (`duplex:'half'`); existing test stack (node --test, supertest, fakeFetch).

**Spec:** `docs/superpowers/specs/2026-07-03-local-whisper-design.md`

## Global Constraints

- Work on branch `feature/local-whisper` off `main`.
- Whisper service is NOT published to the host — no `ports:` on the service; app reaches it at `http://whisper:9000` (env `WHISPER_URL`, default that value).
- Env vars: `WHISPER_MODEL` default `large-v3-turbo`; `WHISPER_DEVICE` default `auto` (cuda when available, else cpu — MUST work out of the box on MacBook Pros / any host without an NVIDIA GPU).
- GPU access lives ONLY in an optional override file `docker-compose.gpu.yml`; the base `docker-compose.yml` must contain no `deploy.resources` GPU reservation.
- All Express errors JSON `{ error: "<message>" }`; `GET /api/transcribe/status` returns 200 `{ ok:false }` when the upstream is down (not an error).
- Audio upload cap 25 MB → 413.
- Frontend: with mode `off` or `gpt4o-transcribe`, behavior is byte-identical to today; `local-whisper` is offered in Setup only when the status endpoint reports `ok:true`.
- `cfg.voiceAiCleanup` values: `false` | `'gpt4o-transcribe'` | `'local-whisper'`.
- Server test command: `cd server && npm test`. JS parse check: `node -e "new Function(require('fs').readFileSync('<file>','utf8'))"`.

## File Structure

```
whisper/Dockerfile           # python3.11-slim + faster-whisper + fastapi
whisper/app.py               # /transcribe, /healthz
docker-compose.yml           # whisper service + whisper-models volume; app gets WHISPER_URL
.env.example                 # WHISPER_MODEL / WHISPER_DEVICE
server/routes/transcribe.js  # proxy routes
server/test/transcribe.test.js
server/app.js                # mount /api/transcribe
js/ai.js                     # transcribeWithLocalWhisper + transcribeAudio dispatcher
js/config.js                 # 3-way mode toggle, status-gated visibility
js/voice.js, js/session.js   # mode checks widened via isAudioTranscribeMode()
index.html                   # third Dictation button
README.md                    # setup section
```

---

### Task 1: Whisper container + compose service

**Files:**
- Create: `whisper/Dockerfile`, `whisper/app.py`
- Modify: `docker-compose.yml` (whisper service, volume, app env), `.env.example`

**Interfaces:**
- Produces: container serving `POST /transcribe` (multipart `file`, optional form `language`, `prompt`) → `{ "text": str, "language": str, "duration": float }`; `GET /healthz` → `{ "ok": true, "model": str, "device": str }`. App-side env `WHISPER_URL=http://whisper:9000`.

- [ ] **Step 1: Write whisper/app.py**

```python
"""Thin faster-whisper HTTP wrapper. One model, loaded once, batch transcribe."""
import os
import tempfile

from fastapi import FastAPI, File, Form, UploadFile
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")  # cuda when present, else cpu
COMPUTE = os.environ.get("WHISPER_COMPUTE", "default")  # ctranslate2 picks per device

app = FastAPI()
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)


@app.get("/healthz")
def healthz():
    # model.device reflects what ctranslate2 actually picked under "auto".
    return {"ok": True, "model": MODEL_NAME, "device": model.model.device if hasattr(model, "model") else DEVICE}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form(""),
    prompt: str = Form(""),
):
    # faster-whisper wants a path or file-like; spool to a temp file so
    # ffmpeg can sniff the container format (webm/ogg/mp4/wav).
    with tempfile.NamedTemporaryFile(suffix=os.path.splitext(file.filename or "a.webm")[1] or ".webm") as tmp:
        tmp.write(await file.read())
        tmp.flush()
        segments, info = model.transcribe(
            tmp.name,
            language=language or None,
            initial_prompt=prompt or None,
            vad_filter=True,
            temperature=0,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": info.language, "duration": info.duration}
```

- [ ] **Step 2: Write whisper/Dockerfile**

```dockerfile
FROM python:3.11-slim

# ffmpeg: faster-whisper decodes browser audio containers through it.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir faster-whisper==1.* fastapi==0.115.* uvicorn==0.30.* python-multipart==0.0.*

WORKDIR /srv
COPY app.py .

ENV HF_HOME=/models
EXPOSE 9000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000"]
```

- [ ] **Step 3: Compose wiring**

In `docker-compose.yml` add to the `app` service environment:
```yaml
      WHISPER_URL: http://whisper:9000
```
Add the service and volume:
```yaml
  whisper:
    build: ./whisper
    environment:
      WHISPER_MODEL: ${WHISPER_MODEL:-large-v3-turbo}
      WHISPER_DEVICE: ${WHISPER_DEVICE:-auto}
    volumes:
      - whisper-models:/models
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://localhost:9000/healthz')"]
      interval: 15s
      timeout: 5s
      retries: 20
      start_period: 120s
    restart: unless-stopped
```
(`start_period` is long: first boot downloads the model, ~1.5 GB.) Add `whisper-models:` under `volumes:`.

Create `docker-compose.gpu.yml` (repo root) — the GPU is OPT-IN so the base compose works on MacBook Pros and any host without NVIDIA hardware:
```yaml
# Optional NVIDIA GPU for the whisper service. Requires nvidia-container-toolkit.
# Use: docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
# or put in .env:  COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
services:
  whisper:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

`.env.example`, after `OPENROUTER_MODEL`:
```bash
# Local Whisper dictation (whisper container).
# large-v3-turbo = fast, near-large-v3 quality. Use large-v3 for max accuracy.
WHISPER_MODEL=large-v3-turbo
# auto = GPU when available, CPU otherwise (Macs run CPU — that's fine).
WHISPER_DEVICE=auto
# NVIDIA GPU hosts: uncomment to enable GPU passthrough (needs nvidia-container-toolkit).
# COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
```

- [ ] **Step 4: Smoke test**

The base compose has no GPU dependency, so this works on any host.

Run: `docker compose up -d --build whisper && sleep 240 && docker compose exec whisper python -c "import urllib.request;print(urllib.request.urlopen('http://localhost:9000/healthz').read())"`
Expected: `{"ok": true, "model": "large-v3-turbo", "device": "cpu"}` (device is cpu without the GPU override; cuda when launched with docker-compose.gpu.yml on an NVIDIA host with the toolkit).

- [ ] **Step 5: Commit**

```bash
git add whisper/ docker-compose.yml docker-compose.gpu.yml .env.example
git commit -m "feat(whisper): faster-whisper transcription container (CPU default, GPU opt-in)"
```

---

### Task 2: Express proxy routes

**Files:**
- Create: `server/routes/transcribe.js`
- Test: `server/test/transcribe.test.js`
- Modify: `server/app.js` (mount)

**Interfaces:**
- Consumes: `createApp(db, { fetchImpl, env })`; env `WHISPER_URL`.
- Produces: `POST /api/transcribe` (multipart passthrough → whisper `/transcribe`, upstream status+JSON passed through, 503 `{error:'Whisper service unavailable'}` on network failure, 413 over 25 MB); `GET /api/transcribe/status` → upstream `/healthz` JSON, or `{ ok:false }` (200) when down. `transcribeRouter({ fetchImpl, env })`.

- [ ] **Step 1: Write the failing tests**

`server/test/transcribe.test.js`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { startMemoryMongo } from './helpers.js';

let mem;
before(async () => { mem = await startMemoryMongo(); });
after(() => mem.stop());

function fakeWhisper({ status = 200, body = '{"text":"привіт світ","language":"uk","duration":2.1}', fail = false } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (fail) throw new Error('ECONNREFUSED');
    return { status, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const ENV = { WHISPER_URL: 'http://whisper-test:9000' };

test('POST forwards multipart to the whisper service and passes JSON through', async () => {
  const f = fakeWhisper();
  const app = createApp(mem.db, { fetchImpl: f, env: ENV });
  const res = await request(app).post('/api/transcribe')
    .field('language', 'uk')
    .attach('file', Buffer.from('fake-audio'), { filename: 'a.webm', contentType: 'audio/webm' });
  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'привіт світ');
  assert.equal(f.calls[0].url, 'http://whisper-test:9000/transcribe');
  assert.match(f.calls[0].opts.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.equal(f.calls[0].opts.duplex, 'half');
});

test('upstream non-200 passes through', async () => {
  const f = fakeWhisper({ status: 422, body: '{"detail":"bad audio"}' });
  const app = createApp(mem.db, { fetchImpl: f, env: ENV });
  const res = await request(app).post('/api/transcribe')
    .attach('file', Buffer.from('x'), 'a.webm');
  assert.equal(res.status, 422);
  assert.equal(res.body.detail, 'bad audio');
});

test('network failure is a 503', async () => {
  const app = createApp(mem.db, { fetchImpl: fakeWhisper({ fail: true }), env: ENV });
  const res = await request(app).post('/api/transcribe')
    .attach('file', Buffer.from('x'), 'a.webm');
  assert.equal(res.status, 503);
  assert.match(res.body.error, /unavailable/i);
});

test('oversized upload is a 413 without calling upstream', async () => {
  const f = fakeWhisper();
  const app = createApp(mem.db, { fetchImpl: f, env: ENV });
  const res = await request(app).post('/api/transcribe')
    .set('Content-Length', String(26 * 1024 * 1024))
    .set('Content-Type', 'multipart/form-data; boundary=x')
    .send();
  assert.equal(res.status, 413);
  assert.equal(f.calls.length, 0);
});

test('status endpoint proxies healthz', async () => {
  const f = fakeWhisper({ body: '{"ok":true,"model":"large-v3-turbo","device":"cuda"}' });
  const app = createApp(mem.db, { fetchImpl: f, env: ENV });
  const res = await request(app).get('/api/transcribe/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, model: 'large-v3-turbo', device: 'cuda' });
  assert.equal(f.calls[0].url, 'http://whisper-test:9000/healthz');
});

test('status endpoint softens a dead upstream to ok:false', async () => {
  const app = createApp(mem.db, { fetchImpl: fakeWhisper({ fail: true }), env: ENV });
  const res = await request(app).get('/api/transcribe/status');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: false });
});
```

Run: `cd server && node --test test/transcribe.test.js` — FAIL (404).

- [ ] **Step 2: Implement the router**

`server/routes/transcribe.js`:
```js
import { Router } from 'express';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Proxy to the whisper container. The multipart body is streamed through
// untouched (duplex:'half' is required by undici for request streams), so
// this route must be mounted BEFORE any body parser touches multipart —
// express.json() ignores multipart, so the global mount order is fine.
export function transcribeRouter({ fetchImpl = fetch, env = process.env } = {}) {
  const base = () => (env.WHISPER_URL || 'http://whisper:9000').replace(/\/+$/, '');
  const r = Router();

  r.post('/', async (req, res) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_AUDIO_BYTES) {
      return res.status(413).json({ error: 'Audio too large (max 25 MB)' });
    }
    try {
      const upstream = await fetchImpl(base() + '/transcribe', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' },
        body: req,
        duplex: 'half',
      });
      const text = await upstream.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      res.status(upstream.status).json(data);
    } catch {
      res.status(503).json({ error: 'Whisper service unavailable' });
    }
  });

  r.get('/status', async (_req, res) => {
    try {
      const upstream = await fetchImpl(base() + '/healthz');
      const data = JSON.parse(await upstream.text());
      res.json(data);
    } catch {
      res.json({ ok: false });
    }
  });

  return r;
}
```

`server/app.js`: `import { transcribeRouter } from './routes/transcribe.js';` and mount `app.use('/api/transcribe', transcribeRouter({ fetchImpl, env }));` with the other /api mounts.

- [ ] **Step 3: Run tests**

Run: `cd server && npm test`
Expected: PASS (all suites, 36 total: 30 existing + 6 new).

- [ ] **Step 4: Commit**

```bash
git add server/routes/transcribe.js server/test/transcribe.test.js server/app.js
git commit -m "feat(server): transcription proxy to the whisper container"
```

---

### Task 3: Frontend — Local Whisper mode

**Files:**
- Modify: `index.html` (third Dictation button, ~line 213), `js/config.js` (mode handling ~lines 110-131 and migration ~663-667; status-gated visibility), `js/ai.js` (new `transcribeWithLocalWhisper` + `transcribeAudio` dispatcher after `transcribeWithGpt4o`, line ~178), `js/voice.js` + `js/session.js` (widen mode checks)

**Interfaces:**
- Consumes: `effectiveBackendUrl()` + `detectBackend()` from js/config.js; `transcribeWithGpt4o(audioBlob, languageHint)` in js/ai.js; `transcribeLanguageHint(lang)`; context-words glossary via `cfg.contextWords` (array of `{term}` objects — verify actual shape in js/context.js and use its terms).
- Produces: `transcribeAudio(audioBlob, languageHint)` — dispatcher used by all call sites; `isAudioTranscribeMode()` (js/config.js) → true when mode is `gpt4o-transcribe` OR `local-whisper`.

- [ ] **Step 1: index.html — third toggle button**

After the `vcGpt4oTranscribe` button (line ~213) add:
```html
            <button class="lang-btn" id="vcLocalWhisper" onclick="setVoiceCleanup('local-whisper')" style="display:none">🏠 Local Whisper</button>
```

- [ ] **Step 2: js/config.js — 3-way mode + visibility**

Replace the voiceAiCleanup block (lines ~110-131) so:
```js
// cfg.voiceAiCleanup stores: false = off · 'gpt4o-transcribe' · 'local-whisper'.
const AUDIO_TRANSCRIBE_MODES = ['gpt4o-transcribe', 'local-whisper'];

function voiceCleanupMode() {
  return AUDIO_TRANSCRIBE_MODES.includes(cfg.voiceAiCleanup) ? cfg.voiceAiCleanup : 'off';
}

function isAudioTranscribeMode() {
  return AUDIO_TRANSCRIBE_MODES.includes(cfg.voiceAiCleanup);
}

function renderVoiceCleanup() {
  const mode = voiceCleanupMode();
  const off  = document.getElementById('vcOff');
  const g4o  = document.getElementById('vcGpt4oTranscribe');
  const lw   = document.getElementById('vcLocalWhisper');
  if (off) off.classList.toggle('active', mode === 'off');
  if (g4o) g4o.classList.toggle('active', mode === 'gpt4o-transcribe');
  if (lw)  lw.classList.toggle('active', mode === 'local-whisper');
}

function setVoiceCleanup(mode) {
  cfg.voiceAiCleanup = AUDIO_TRANSCRIBE_MODES.includes(mode) ? mode : false;
  localStorage.setItem('bra_cfg', JSON.stringify(cfg));
  renderVoiceCleanup();
  toast(mode === 'gpt4o-transcribe'
    ? '✓ GPT-4o Transcribe — final text is transcribed from audio after Pause / Stop'
    : mode === 'local-whisper'
      ? '✓ Local Whisper — audio is transcribed on your own server after Pause / Stop'
      : '✓ Web Speech only');
}
```
(Keep the surrounding function names/ids as they are in the file — the block above must be adapted to the existing `vcOff` id; check the actual ids in index.html around line 211 and preserve any existing behavior for the off/gpt4o toasts.)

Migration (lines ~663-667): extend the recognized values —
```js
      if (cfg.voiceAiCleanup === true || cfg.voiceAiCleanup === 'stop' || cfg.voiceAiCleanup === 'whisper-turbo' || cfg.voiceAiCleanup === 'live') {
        cfg.voiceAiCleanup = 'gpt4o-transcribe';
      } else if (cfg.voiceAiCleanup !== false && !AUDIO_TRANSCRIBE_MODES.includes(cfg.voiceAiCleanup)) {
        cfg.voiceAiCleanup = DEFAULTS.voiceAiCleanup;
      }
```

Visibility — append:
```js
// Show the Local Whisper option only when the backend reports the
// whisper container healthy. If the saved mode is local-whisper but the
// service is gone, fall back to Web Speech so dictation never dead-ends.
async function renderLocalWhisperOption() {
  const btn = document.getElementById('vcLocalWhisper');
  const base = effectiveBackendUrl();
  if (!btn) return;
  if (!base) { btn.style.display = 'none'; return; }
  try {
    const j = await (await fetch(base + '/api/transcribe/status')).json();
    btn.style.display = j.ok ? '' : 'none';
    if (!j.ok && cfg.voiceAiCleanup === 'local-whisper') setVoiceCleanup(false);
  } catch {
    btn.style.display = 'none';
  }
}
```
In `detectBackend()`, after `renderServerJiraStatus();` add `renderLocalWhisperOption();`.

- [ ] **Step 3: js/ai.js — local transcription + dispatcher**

After `transcribeWithGpt4o` (ends ~line 216) add:
```js
// Local Whisper via the backend proxy (whisper container). languageHint is
// the same value transcribeLanguageHint() produces ('uk' / 'en' / '').
async function transcribeWithLocalWhisper(audioBlob, languageHint) {
  const base = effectiveBackendUrl();
  if (!base) throw new Error('No backend available for Local Whisper');
  if (!audioBlob || !audioBlob.size) throw new Error('No audio was recorded');
  const fd = new FormData();
  const ext = audioBlob.type.includes('ogg') ? 'ogg' : audioBlob.type.includes('mp4') ? 'mp4' : 'webm';
  fd.append('file', audioBlob, 'dictation.' + ext);
  if (languageHint) fd.append('language', languageHint);
  // Glossary terms bias Whisper toward the exact product spellings.
  const terms = (cfg.contextWords || []).map(w => w && (w.term || w)).filter(Boolean);
  if (terms.length) fd.append('prompt', terms.join(', '));
  const res = await fetch(base + '/api/transcribe', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.detail || `HTTP ${res.status}`);
  return String(data.text || '').trim();
}

// Single entry point for the record-then-transcribe modes.
async function transcribeAudio(audioBlob, languageHint) {
  return cfg.voiceAiCleanup === 'local-whisper'
    ? transcribeWithLocalWhisper(audioBlob, languageHint)
    : transcribeWithGpt4o(audioBlob, languageHint);
}
```
Adapt the `cfg.contextWords` access to the real glossary shape found in js/context.js (use its accessor if one exists).

- [ ] **Step 4: Widen the call sites**

In `js/voice.js` and `js/session.js`:
- Replace every comparison `cfg.voiceAiCleanup === 'gpt4o-transcribe'` with `isAudioTranscribeMode()` (grep finds them: voice.js ~543, ~723; session.js ~214, ~278, ~762, ~928).
- Replace the two calls `transcribeWithGpt4o(audioBlob, ...)` with `transcribeAudio(audioBlob, ...)` (voice.js ~91, session.js ~329) and the guards `typeof transcribeWithGpt4o !== 'function'` with `typeof transcribeAudio !== 'function'` (voice.js ~77, session.js ~311).
- session.js ~311 also guards `if (!apiKey ...) return` — make the apiKey requirement apply only when the mode is `gpt4o-transcribe`:
```js
  if (cfg.voiceAiCleanup === 'gpt4o-transcribe' && !apiKey) return;
```
(voice.js has an equivalent apiKey/provider guard near its transcribe path — apply the same conditioning there; `transcribeWithGpt4o` itself still throws its own clear errors.)

- [ ] **Step 5: Verify**

Parse-check js/config.js, js/ai.js, js/voice.js, js/session.js with the standard `new Function` command. Grep: `grep -n "gpt4o-transcribe" js/voice.js js/session.js` — remaining hits must be intentional (apiKey conditioning, mode-specific UI text), not widened-away logic checks.

- [ ] **Step 6: Commit**

```bash
git add index.html js/config.js js/ai.js js/voice.js js/session.js
git commit -m "feat(app): Local Whisper dictation mode via backend proxy"
```

---

### Task 4: README + end-to-end verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README section**

In the self-hosted backend section, after the Jira credentials material:
```markdown
### Local Whisper dictation (free, private, GPU)

The docker stack includes a `whisper` container (faster-whisper,
`large-v3-turbo` by default) so dictation can be transcribed on your own
hardware — no cloud key, strong Ukrainian support.

It runs on CPU out of the box — MacBook Pros and any other host work with
plain `docker compose up -d --build` (expect ~5-20 s per dictation on CPU;
Mac users pointing at the team's LAN server don't run it at all). First
start downloads the model (~1.5 GB, cached in a volume). Want maximum
accuracy? Set `WHISPER_MODEL=large-v3` in `.env`.

**NVIDIA GPU host (near-instant transcription):** install the container
toolkit once, then enable the GPU override:

```bash
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
# in .env:
# COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
docker compose up -d --build
```

In **⚙️ Setup → Dictation** a **🏠 Local Whisper** option appears when the
service is healthy — recording works like GPT-4o Transcribe (transcript
appears after Pause/Stop), but audio never leaves your network. Your
Context words glossary is passed to Whisper as a recognition hint.
```

- [ ] **Step 2: End-to-end verification**

1. `docker compose up -d --build` (CPU mode if toolkit missing).
2. `curl -s http://localhost:${PORT:-3000}/api/transcribe/status` → `{"ok":true,...}` once the model loads.
3. Real transcription round-trip without a browser: generate a short wav and POST it:
   `docker compose exec whisper python -c "import wave,struct,math;w=wave.open('/tmp/t.wav','w');w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b''.join(struct.pack('<h',int(8000*math.sin(2*math.pi*440*i/16000))) for i in range(16000)));w.close()"` then `docker compose exec whisper python -c "import urllib.request,mimetypes;print('use curl instead')"` — simpler from the host: `curl -s -F file=@/tmp/tone.wav http://localhost:${PORT:-3000}/api/transcribe` after copying the wav out (`docker compose cp whisper:/tmp/t.wav /tmp/tone.wav`). A tone yields empty/near-empty text — success is a 200 JSON `{"text":...}` response, not meaningful words.
4. Browser: Setup → Dictation shows 🏠 Local Whisper; select it, dictate on the Report page, transcript lands after Stop.
5. `cd server && npm test` — all green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: local Whisper dictation setup"
```

---

## Final verification (after all tasks)

1. Full stack `docker compose up -d --build`; `/api/transcribe/status` ok; dictation round-trip per Task 4.
2. Regression: mode `off` and `gpt4o-transcribe` flows unchanged (dictate with Web Speech; if an OpenRouter key is configured, a GPT-4o transcription still works).
3. `cd server && npm test` — 36/36.
4. superpowers:verification-before-completion, then superpowers:finishing-a-development-branch.
