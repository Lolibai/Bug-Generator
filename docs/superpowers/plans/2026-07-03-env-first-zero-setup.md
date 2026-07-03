# Env-First Zero Setup + Connection Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With credentials in `.env`, teammates use generation, Jira push and dictation with zero UI setup (`.env` beats UI), and a Setup status card + status dot show that everything is connected.

**Architecture:** New `server/routes/ai.js` proxies LLM chat calls with the server's env key; the Jira proxy's credential order flips to env → stored → body; `js/ai.js#callAi` routes through the backend when a server key exists. A Setup "Connection status" card runs five parallel checks (backend, mongo, AI, Jira `/myself`, whisper) and feeds an aggregate dot in the sidebar + mobile tab bar.

**Tech Stack:** Existing stack only — Express + injectable fetch, node --test/supertest, plain JS frontend.

**Spec:** `docs/superpowers/specs/2026-07-03-env-first-zero-setup-design.md`

## Global Constraints

- Branch: continue on `feature/local-whisper` (stacked feature; do not switch).
- AI env selection: `OPENROUTER_API_KEY` (+ `OPENROUTER_MODEL`, default `anthropic/claude-3.5-haiku`) preferred; else `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`, default `claude-sonnet-4-20250514`). No key → `/api/ai` 503, `/api/ai/status` `{available:false, provider:null, model:null}`.
- Jira proxy credential order (server side): env → Mongo `settings` doc → request body. Field-by-field (each of url/email/token resolves independently through the chain, same as today but reversed).
- All server errors JSON `{error}`; `/api/ai` upstream failure → 502 with the provider's message.
- Frontend: server AI key active → ALL `callAi` traffic goes through backend; browser key used only when no server key. GPT-4o Transcribe untouched (browser key only).
- Status card: checks run in parallel, failures render as row states, never toasts; ✓ Jira only on live `/myself` success.
- Server tests: `cd server && npm test` (currently 36 pass; Task 1 adds ~7, Task 2 adjusts jira tests). Parse check for JS: `node -e "new Function(require('fs').readFileSync('<f>','utf8'))"`.

## File Structure

```
server/routes/ai.js          # POST /api/ai + GET /api/ai/status
server/test/ai.test.js
server/routes/jira.js        # flip credential order
server/routes/settings.js    # envConfigured + source in GET
server/test/jira.test.js     # order tests updated/added
server/test/settings.test.js # source/envConfigured tests
server/app.js                # mount /api/ai
js/ai.js                     # callAi backend routing
js/config.js                 # serverAi cache; status card logic; dot
index.html                   # status card markup; dots in sidebar + tabbar
css/styles.css               # status row / dot styles
README.md, .env.example      # zero-setup docs, ANTHROPIC_* vars
```

---

### Task 1: `/api/ai` proxy + status endpoint

**Files:**
- Create: `server/routes/ai.js`
- Test: `server/test/ai.test.js`
- Modify: `server/app.js` (mount), `.env.example` (ANTHROPIC vars)

**Interfaces:**
- Consumes: `createApp(db, { fetchImpl, env })` factory (server/app.js).
- Produces: `aiRouter({ fetchImpl, env })`; `POST /api/ai` `{system, user}` → `{text}`; `GET /api/ai/status` → `{available, provider, model}`.

- [ ] **Step 1: Write the failing tests**

`server/test/ai.test.js`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { startMemoryMongo } from './helpers.js';

let mem;
before(async () => { mem = await startMemoryMongo(); });
after(() => mem.stop());

function fakeLlm({ status = 200, body, fail = false } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts: { ...opts, body: JSON.parse(opts.body) } });
    if (fail) throw new Error('ECONNREFUSED');
    return { status, ok: status >= 200 && status < 300, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const OR_BODY = JSON.stringify({ choices: [{ message: { content: 'openrouter says hi' } }] });
const AN_BODY = JSON.stringify({ content: [{ text: 'anthropic says hi' }] });

test('status: available with openrouter env key', async () => {
  const app = createApp(mem.db, { env: { OPENROUTER_API_KEY: 'or-k', OPENROUTER_MODEL: 'test/model' } });
  const res = await request(app).get('/api/ai/status');
  assert.deepEqual(res.body, { available: true, provider: 'openrouter', model: 'test/model' });
});

test('status: unavailable without keys', async () => {
  const app = createApp(mem.db, { env: {} });
  const res = await request(app).get('/api/ai/status');
  assert.deepEqual(res.body, { available: false, provider: null, model: null });
});

test('POST uses openrouter with env key and returns text', async () => {
  const f = fakeLlm({ body: OR_BODY });
  const app = createApp(mem.db, { fetchImpl: f, env: { OPENROUTER_API_KEY: 'or-k', OPENROUTER_MODEL: 'test/model' } });
  const res = await request(app).post('/api/ai').send({ system: 'sys', user: 'usr' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { text: 'openrouter says hi' });
  const call = f.calls[0];
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.opts.headers.Authorization, 'Bearer or-k');
  assert.equal(call.opts.body.model, 'test/model');
  assert.deepEqual(call.opts.body.messages[0], { role: 'system', content: 'sys' });
});

test('POST falls back to anthropic when only ANTHROPIC_API_KEY set', async () => {
  const f = fakeLlm({ body: AN_BODY });
  const app = createApp(mem.db, { fetchImpl: f, env: { ANTHROPIC_API_KEY: 'an-k' } });
  const res = await request(app).post('/api/ai').send({ system: 'sys', user: 'usr' });
  assert.deepEqual(res.body, { text: 'anthropic says hi' });
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.opts.headers['x-api-key'], 'an-k');
  assert.equal(call.opts.body.system, 'sys');
});

test('openrouter preferred when both keys set', async () => {
  const f = fakeLlm({ body: OR_BODY });
  const app = createApp(mem.db, { fetchImpl: f, env: { OPENROUTER_API_KEY: 'or-k', ANTHROPIC_API_KEY: 'an-k' } });
  await request(app).post('/api/ai').send({ system: 's', user: 'u' });
  assert.match(f.calls[0].url, /openrouter/);
});

test('503 when no server key', async () => {
  const app = createApp(mem.db, { fetchImpl: fakeLlm({}), env: {} });
  const res = await request(app).post('/api/ai').send({ system: 's', user: 'u' });
  assert.equal(res.status, 503);
  assert.match(res.body.error, /no server ai key/i);
});

test('400 on missing system/user; 502 on upstream failure', async () => {
  const env = { OPENROUTER_API_KEY: 'k' };
  const app1 = createApp(mem.db, { fetchImpl: fakeLlm({}), env });
  assert.equal((await request(app1).post('/api/ai').send({ system: 's' })).status, 400);
  const app2 = createApp(mem.db, { fetchImpl: fakeLlm({ fail: true }), env });
  const res = await request(app2).post('/api/ai').send({ system: 's', user: 'u' });
  assert.equal(res.status, 502);
});
```

Run: `cd server && node --test test/ai.test.js` — FAIL (404).

- [ ] **Step 2: Implement**

`server/routes/ai.js`:
```js
import { Router } from 'express';

// LLM proxy so browsers need no key of their own: the server's .env key
// has top priority for the whole team. OpenRouter preferred over Anthropic.
function pickProvider(env) {
  if (env.OPENROUTER_API_KEY) {
    return { provider: 'openrouter', key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku' };
  }
  if (env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', key: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514' };
  }
  return null;
}

export function aiRouter({ fetchImpl = fetch, env = process.env } = {}) {
  const r = Router();

  r.get('/status', (_req, res) => {
    const p = pickProvider(env);
    res.json(p ? { available: true, provider: p.provider, model: p.model }
               : { available: false, provider: null, model: null });
  });

  r.post('/', async (req, res) => {
    const { system, user } = req.body || {};
    if (typeof system !== 'string' || typeof user !== 'string' || !system || !user) {
      return res.status(400).json({ error: 'system and user (strings) are required' });
    }
    const p = pickProvider(env);
    if (!p) return res.status(503).json({ error: 'No server AI key configured (.env OPENROUTER_API_KEY / ANTHROPIC_API_KEY)' });

    try {
      let upstream, data;
      if (p.provider === 'openrouter') {
        upstream = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key },
          body: JSON.stringify({
            model: p.model,
            max_tokens: 1600,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          }),
        });
        data = JSON.parse(await upstream.text());
        if (upstream.status < 200 || upstream.status >= 300) {
          return res.status(502).json({ error: data.error?.message || `OpenRouter HTTP ${upstream.status}` });
        }
        return res.json({ text: data.choices?.[0]?.message?.content || '' });
      }
      upstream = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: p.model,
          max_tokens: 1600,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      data = JSON.parse(await upstream.text());
      if (upstream.status < 200 || upstream.status >= 300) {
        return res.status(502).json({ error: data.error?.message || `Anthropic HTTP ${upstream.status}` });
      }
      return res.json({ text: (data.content || []).map(i => i.text || '').join('') });
    } catch (e) {
      return res.status(502).json({ error: 'AI upstream failed: ' + e.message });
    }
  });

  return r;
}
```

`server/app.js`: import and mount `app.use('/api/ai', aiRouter({ fetchImpl, env }));`

`.env.example`, after the OPENROUTER lines:
```bash
# Alternative server AI key (used when OPENROUTER_API_KEY is empty).
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

- [ ] **Step 3: Run tests** — `cd server && npm test` → PASS (43).

- [ ] **Step 4: Commit**

```bash
git add server/routes/ai.js server/test/ai.test.js server/app.js .env.example
git commit -m "feat(server): AI proxy with env-key priority"
```

---

### Task 2: Flip Jira credential order + settings source

**Files:**
- Modify: `server/routes/jira.js` (resolution order), `server/routes/settings.js` (GET adds `envConfigured`/`source`)
- Test: `server/test/jira.test.js` (update order tests, add env-beats-body), `server/test/settings.test.js` (source tests)

**Interfaces:**
- Consumes: existing `jiraRouter({fetchImpl, env, db})`, `settingsRouter(db)` — settingsRouter gains an `env` option: `settingsRouter(db, { env = process.env } = {})`; update the `server/app.js` mount to `settingsRouter(db, { env })`.
- Produces: Jira creds resolve env → stored → body (per field); `GET /api/settings/jira` → `{ jiraUrl, jiraEmail, tokenSet, envConfigured, source }` where `source` is `'env'` (all three env vars set) | `'server'` (stored doc has a token) | `'none'`.

- [ ] **Step 1: Update/add failing tests**

In `server/test/jira.test.js`: the existing test `request-body creds beat stored settings` stays valid ONLY when env is empty — keep it (env `{}` already). ADD:
```js
test('env creds beat body and stored', async () => {
  await mem.db.collection('settings').updateOne(
    { _id: 'jira' },
    { $set: { jiraUrl: 'https://stored.atlassian.net', jiraEmail: 's@x.com', jiraToken: 'stok' } },
    { upsert: true });
  const f = fakeFetch();
  const app = createApp(mem.db, {
    fetchImpl: f,
    env: { JIRA_BASE_URL: 'https://env.atlassian.net', JIRA_EMAIL: 'e@x.com', JIRA_API_TOKEN: 'etok' },
  });
  const res = await request(app).post('/api/jira').send(envelope); // envelope carries body creds
  assert.equal(res.status, 200);
  assert.equal(f.calls[0].url, 'https://env.atlassian.net/rest/api/3/myself');
  const auth = f.calls[0].opts.headers.Authorization;
  assert.equal(auth, 'Basic ' + Buffer.from('e@x.com:etok').toString('base64'));
  await mem.db.collection('settings').deleteMany({});
});

test('stored beats body when env empty', async () => {
  await mem.db.collection('settings').updateOne(
    { _id: 'jira' },
    { $set: { jiraUrl: 'https://stored.atlassian.net', jiraEmail: 's@x.com', jiraToken: 'stok' } },
    { upsert: true });
  const f = fakeFetch();
  const app = createApp(mem.db, { fetchImpl: f, env: {} });
  await request(app).post('/api/jira').send(envelope);
  assert.equal(f.calls[0].url, 'https://stored.atlassian.net/rest/api/3/myself');
  await mem.db.collection('settings').deleteMany({});
});
```
DELETE the now-obsolete `request-body creds beat stored settings` test (body no longer beats stored) and the old `env vars fill in missing credentials` stays (env now simply wins).

In `server/test/settings.test.js` ADD:
```js
test('GET reports source env when all JIRA_* env set', async () => {
  const envApp = createApp(mem.db, { env: { JIRA_BASE_URL: 'https://e.x', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' } });
  const res = await request(envApp).get('/api/settings/jira');
  assert.equal(res.body.envConfigured, true);
  assert.equal(res.body.source, 'env');
});

test('GET reports source server when stored token exists and env empty', async () => {
  await request(app).put('/api/settings/jira')
    .send({ jiraUrl: 'https://a.x', jiraEmail: 'a@a.a', jiraToken: 'tok' });
  const res = await request(app).get('/api/settings/jira');
  assert.equal(res.body.envConfigured, false);
  assert.equal(res.body.source, 'server');
});

test('GET reports source none when nothing configured', async () => {
  const res = await request(app).get('/api/settings/jira');
  assert.equal(res.body.source, 'none');
});
```
(The `app` in that file is built with `env: {}` — keep it; add the env-specific app inline as shown.)

Run: `cd server && npm test` — new tests FAIL.

- [ ] **Step 2: Implement**

`server/routes/jira.js` — resolution block becomes (env first, per field):
```js
    const b = req.body || {};
    let stored = null;
    if (db) {
      stored = await db.collection('settings').findOne({ _id: 'jira' }).catch(() => null);
    }
    const jiraUrl   = env.JIRA_BASE_URL  || (stored && stored.jiraUrl)   || b.jiraUrl;
    const jiraEmail = env.JIRA_EMAIL     || (stored && stored.jiraEmail) || b.jiraEmail;
    const jiraToken = env.JIRA_API_TOKEN || (stored && stored.jiraToken) || b.jiraToken;
```
(Note: always fetch `stored` when db is present — env may cover only some fields.)

`server/routes/settings.js` — signature `settingsRouter(db, { env = process.env } = {})`; GET handler:
```js
  const envConfigured = !!(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
  const doc = await col.findOne({ _id: 'jira' });
  const shape = publicShape(doc);
  res.json({
    ...shape,
    envConfigured,
    source: envConfigured ? 'env' : (shape.tokenSet ? 'server' : 'none'),
  });
```
`server/app.js`: mount becomes `settingsRouter(db, { env })`.

- [ ] **Step 3: Run tests** — `cd server && npm test` → PASS (46: 43 + 3 settings + 2 jira − 1 deleted... verify actual count and record it).

- [ ] **Step 4: Commit**

```bash
git add server/routes/jira.js server/routes/settings.js server/app.js server/test/jira.test.js server/test/settings.test.js
git commit -m "feat(server): env-first credential priority for Jira, settings source flag"
```

---

### Task 3: Frontend — callAi routing + connection status card + dots

**Files:**
- Modify: `js/config.js` (serverAi cache in detectBackend ~line 739; status card + dot logic appended), `js/ai.js` (callAi routing, lines 126-168), `index.html` (status card first in page-setup; dot spans in sidebar logo area and tab-setup), `css/styles.css` (row/dot styles)

**Interfaces:**
- Consumes: `effectiveBackendUrl()`, `detectBackend()` (js/config.js:739, calls renderLanHint/renderServerJiraStatus/renderLocalWhisperOption at 746-748); `callAi(systemPrompt, userText)` js/ai.js:126; `jiraRequest(path)` via `testJiraConnection` pattern js/jira.js:616; `updateApiBtn()` in js/ui.js.
- Produces: global `serverAi = { available:false, provider:null, model:null }` (js/config.js); `refreshConnectionStatus()`; `callAi` transparently backend-routed.

- [ ] **Step 1: serverAi cache + callAi routing**

`js/config.js` — near the top of the zero-config backend section add:
```js
// Server-side AI key info (from /api/ai/status). When available, ALL LLM
// calls route through the backend — .env has top priority over browser keys.
let serverAi = { available: false, provider: null, model: null };

async function refreshServerAi() {
  const base = effectiveBackendUrl();
  if (!base) { serverAi = { available: false, provider: null, model: null }; return; }
  try {
    serverAi = await (await fetch(base + '/api/ai/status')).json();
  } catch {
    serverAi = { available: false, provider: null, model: null };
  }
}
```
In `detectBackend()` insert `await refreshServerAi();` before the render calls (so dependents see it), then add `if (typeof updateApiBtn === 'function') updateApiBtn();` after the renders.

`js/ai.js` — at the top of `callAi` (line 127) insert:
```js
  // .env-first: when the server holds an AI key, every browser uses it.
  if (typeof serverAi !== 'undefined' && serverAi.available) {
    const res = await fetch(effectiveBackendUrl() + '/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: systemPrompt, user: userText }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return String(data.text || '');
  }
```

`js/ui.js` — in `updateApiBtn()`, before the existing apiKey branch add:
```js
  if (typeof serverAi !== 'undefined' && serverAi.available) {
    document.querySelectorAll('[data-api-btn]').forEach(btn => {
      const icon = btn.querySelector('[data-api-icon]');
      const lbl  = btn.querySelector('[data-api-lbl]');
      if (icon) icon.textContent = '●';
      if (lbl)  lbl.textContent  = 'Server key (.env)';
      btn.classList.add('set');
      btn.title = 'The server\'s .env key is used for everyone. A personal key only applies if the server key is removed.';
    });
    return;
  }
```

- [ ] **Step 2: Status card markup + styles**

`index.html` — FIRST card inside `page-setup` (before the mobile-only provider card):
```html
      <div class="card">
        <div class="card-head">
          <span class="card-title">Connection status</span>
          <button class="btn btn-ghost btn-sm" onclick="refreshConnectionStatus()">↻ Check all</button>
        </div>
        <div class="card-body" id="connStatus">
          <div class="conn-row" id="cs-backend"><span class="conn-ico">…</span> Backend <span class="conn-detail"></span></div>
          <div class="conn-row" id="cs-db"><span class="conn-ico">…</span> Database <span class="conn-detail"></span></div>
          <div class="conn-row" id="cs-ai"><span class="conn-ico">…</span> AI <span class="conn-detail"></span></div>
          <div class="conn-row" id="cs-jira"><span class="conn-ico">…</span> Jira <span class="conn-detail"></span></div>
          <div class="conn-row" id="cs-whisper"><span class="conn-ico">…</span> Whisper <span class="conn-detail"></span></div>
        </div>
      </div>
```
Dots: in the sidebar `.sidebar-logo` div add `<span class="status-dot" id="statusDotSidebar" title=""></span>` next to the logo name; in the tab bar's Setup button add `<span class="status-dot" id="statusDotTab" title=""></span>` inside `#tab-setup` after the label.

`css/styles.css` (desktop-safe additions — plain new classes, no media query needed):
```css
/* ── Connection status (Setup card + aggregate dots) ──────────────────── */
.conn-row{display:flex;align-items:center;gap:9px;padding:6px 0;font-size:13px;border-bottom:0.5px solid var(--border)}
.conn-row:last-child{border-bottom:none}
.conn-ico{width:18px;text-align:center;flex-shrink:0}
.conn-row.ok .conn-ico{color:var(--green)}
.conn-row.warn .conn-ico{color:var(--amber)}
.conn-row.bad .conn-ico{color:var(--red)}
.conn-detail{margin-left:auto;font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--muted);text-align:right}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dim);margin-left:6px;vertical-align:middle}
.status-dot.ok{background:var(--green)}
.status-dot.warn{background:var(--amber)}
.status-dot.bad{background:var(--red)}
```

- [ ] **Step 3: Status logic**

`js/config.js`, append:
```js
// ── connection status card + aggregate dot ───────────────────────────────
function setConnRow(id, state, icon, detail) {
  const row = document.getElementById(id);
  if (!row) return;
  row.classList.remove('ok', 'warn', 'bad');
  row.classList.add(state);
  row.querySelector('.conn-ico').textContent = icon;
  row.querySelector('.conn-detail').textContent = detail;
}

async function refreshConnectionStatus() {
  const base = effectiveBackendUrl();
  const states = {}; // row → 'ok'|'warn'|'bad'
  const mark = (key, id, state, icon, detail) => { states[key] = state; setConnRow(id, state, icon, detail); };

  const checks = [];

  if (!base) {
    mark('backend', 'cs-backend', 'warn', '⚠', 'no backend — localStorage only');
    mark('db', 'cs-db', 'warn', '⚠', 'n/a');
    mark('whisper', 'cs-whisper', 'warn', '⚠', 'n/a');
  } else {
    checks.push(fetch(base + '/health').then(r => r.json()).then(j => {
      mark('backend', 'cs-backend', 'ok', '✓', base);
      mark('db', 'cs-db', j.mongo ? 'ok' : 'bad', j.mongo ? '✓' : '✕', j.mongo ? 'MongoDB connected' : 'MongoDB unreachable');
    }).catch(() => {
      mark('backend', 'cs-backend', 'bad', '✕', 'unreachable: ' + base);
      mark('db', 'cs-db', 'bad', '✕', 'unknown');
    }));
    checks.push(fetch(base + '/api/transcribe/status').then(r => r.json()).then(j => {
      if (j.ok) mark('whisper', 'cs-whisper', 'ok', '✓', `${j.model} · ${j.device}`);
      else mark('whisper', 'cs-whisper', 'warn', '⚠', 'service not running');
    }).catch(() => mark('whisper', 'cs-whisper', 'warn', '⚠', 'service not running')));
  }

  // AI: server key beats browser key.
  checks.push((async () => {
    await refreshServerAi();
    if (serverAi.available) mark('ai', 'cs-ai', 'ok', '✓', `server key · ${serverAi.provider}/${serverAi.model}`);
    else if (apiKey) mark('ai', 'cs-ai', 'ok', '✓', "this browser's key · " + provider);
    else mark('ai', 'cs-ai', 'bad', '✕', 'no AI key — set in .env or sidebar');
    if (typeof updateApiBtn === 'function') updateApiBtn();
  })());

  // Jira: source + live /myself auth check.
  checks.push((async () => {
    let source = 'none';
    if (base) {
      try {
        const j = await (await fetch(base + '/api/settings/jira')).json();
        source = j.source || 'none';
      } catch { /* backend without settings API */ }
    }
    if (source === 'none' && !(cfg.jiraUrl && cfg.jiraEmail && cfg.jiraToken)) {
      mark('jira', 'cs-jira', 'bad', '✕', 'not configured');
      return;
    }
    const srcLbl = source === 'env' ? '.env' : source === 'server' ? 'stored on server' : 'this browser';
    try {
      const me = await jiraRequest('/rest/api/3/myself');
      const name = me && (me.displayName || me.emailAddress) || 'authenticated';
      mark('jira', 'cs-jira', 'ok', '✓', `${srcLbl} · ${name}`);
    } catch {
      mark('jira', 'cs-jira', 'warn', '⚠', `${srcLbl} · configured, not verified`);
    }
  })());

  await Promise.allSettled(checks);

  // Aggregate dot: green = core all ok; red = generation impossible; else amber.
  const core = ['backend', 'db', 'ai', 'jira'];
  const dotState = states.ai === 'bad' ? 'bad' : core.every(k => states[k] === 'ok') ? 'ok' : 'warn';
  const notOk = Object.entries(states).filter(([, s]) => s !== 'ok').map(([k]) => k).join(', ');
  ['statusDotSidebar', 'statusDotTab'].forEach(id => {
    const d = document.getElementById(id);
    if (!d) return;
    d.classList.remove('ok', 'warn', 'bad');
    d.classList.add(dotState);
    d.title = dotState === 'ok' ? 'All services connected' : 'Attention: ' + notOk;
  });
}
```
Wire triggers: in `showPage` (js/ui.js) inside the `history`/`context` special-case block add:
```js
  if (n === 'setup' && typeof refreshConnectionStatus === 'function') {
    refreshConnectionStatus();
  }
```
And at the end of `detectBackend()` add `refreshConnectionStatus();` (covers first load on any page for the dot).

- [ ] **Step 4: Verify**

Parse-check js/config.js, js/ai.js, js/ui.js. Live (docker up): Setup shows the card with five rows; with `.env` holding OPENROUTER_API_KEY the AI row says "server key · …" and the sidebar key button reads "● Server key (.env)"; clearing localStorage and generating a report works with no browser key (routes through /api/ai — verify in the Network tab or by server logs). Desktop >768px unchanged elsewhere; dot appears in sidebar and on the Setup tab (mobile).

- [ ] **Step 5: Commit**

```bash
git add js/config.js js/ai.js js/ui.js index.html css/styles.css
git commit -m "feat(app): env-first AI routing and connection status card with aggregate dot"
```

---

### Task 4: README zero-setup docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the section**

In the self-hosted backend section, right after "Run it":
```markdown
### Team zero-setup via .env

Fill these on the server and your teammates configure NOTHING in the UI —
open the LAN URL and everything works ( `.env` has top priority; anything
typed in Setup is only used when the server value is absent):

| Var | Enables |
|---|---|
| `OPENROUTER_API_KEY` (or `ANTHROPIC_API_KEY`) | report generation, template analysis, transcript polish — no browser key needed |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Push to Jira for everyone |
| `HOST_IP` | the in-app "📱 Phone access (LAN)" link |
| `WHISPER_MODEL` / `WHISPER_DEVICE` (optional) | local dictation defaults |

**⚙️ Setup → Connection status** shows a live check of every service —
Backend, Database, AI (which key source is active), Jira (real login
check), Whisper — and a green status dot in the sidebar means "all
connected".
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: team zero-setup via .env and connection status"
```

---

## Final verification (after all tasks)

1. `cd server && npm test` — full suite green (record the new total).
2. `docker compose up -d --build`; put a real or dummy `OPENROUTER_API_KEY` in `.env` temporarily → `/api/ai/status` shows available; status card AI row shows "server key"; remove it and restart → falls back to browser-key behavior.
3. Status card: all five rows render; Jira row ⚠/✕ until creds provided; dot color matches.
4. Regression: with empty env and a browser key, generation works exactly as before.
5. superpowers:verification-before-completion, then superpowers:finishing-a-development-branch.
