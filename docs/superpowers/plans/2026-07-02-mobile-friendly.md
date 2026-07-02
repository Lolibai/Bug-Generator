# Mobile-Friendly Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full mobile parity for the Bug Report Agent via a responsive CSS retrofit: bottom tab bar navigation, stacked/scrollable grids, touch-sized controls, and LAN-access docs.

**Architecture:** Single-stylesheet retrofit. One `@media(max-width:768px)` block at the end of `css/styles.css` replaces the current 580px block. A bottom tab bar is added to `index.html` reusing the existing `showPage()` targets; `js/ui.js` keeps both navs' active state in sync via a shared class. Desktop rendering (>768px) must be pixel-identical to today.

**Tech Stack:** Plain HTML/CSS/JS — no framework, no build step. Spec: `docs/superpowers/specs/2026-07-02-mobile-friendly-design.md`.

## Global Constraints

- Breakpoint is exactly `max-width:768px`; the existing `@media(max-width:580px)` block (css/styles.css:197) is REMOVED and its tweaks folded into the new block.
- Desktop (>768px) must render pixel-identically to before: every new rule lives inside the 768px media query or applies only to elements hidden on desktop.
- No new files except this plan's docs; all CSS goes in `css/styles.css`.
- Element IDs stay unique — mobile duplicates of sidebar controls use classes + `data-` attributes, not duplicated IDs.
- Tab bar bottom padding uses `env(safe-area-inset-bottom)`; `.page` bottom padding uses `calc(70px + env(safe-area-inset-bottom))` on mobile.
- Touch targets `min-height:44px`; inputs/selects/textareas `font-size:16px` on mobile.
- There is no frontend test harness: each task verifies with `node -e "new Function(require('fs').readFileSync('<file>','utf8'))"` for changed JS files (parse check) plus the manual checks listed in the task. Browser verification happens in the final verification section.

## File Structure

```
index.html      # tab bar markup; data- attributes on provider/api buttons; mobile Setup block
css/styles.css  # .tabbar styles (mobile-only) + new 768px media block; 580px block removed
js/ui.js        # showPage syncs .tab-item; setProvider/updateApiBtn drive [data-*] collections
js/config.js    # Backend URL placeholder suggests window.location.origin when served over http(s)
README.md       # "Use it from your phone (LAN)" section
```

---

### Task 1: Bottom tab bar + mobile provider/API-key access

**Files:**
- Modify: `index.html` (tab bar before `</body>`; `data-` attributes on the two provider buttons and the API button in `.sidebar-bottom`, index.html:26-33; mobile-only block at the top of the Setup page card area)
- Modify: `js/ui.js` (showPage: sync `.tab-item`; setProvider/updateApiBtn: operate on collections)
- Modify: `css/styles.css` (tabbar styles; show/hide in the media query added here as the base of the new 768px block)

**Interfaces:**
- Consumes: `showPage(n)`, `setProvider(p)`, `promptKey()`, `updateApiBtn()` in `js/ui.js`; nav ids `nav-report|template|setup|history|context`; globals `provider`, `apiKey`.
- Produces: `.tabbar` fixed bar with buttons `id="tab-report|template|setup|history|context"` and class `tab-item`; `showPage` also toggles `.tab-item` active state by `id="tab-"+n`; provider buttons carry `data-provider-btn="anthropic|openrouter"`, API-key buttons carry `data-api-btn` with inner `<span data-api-icon>` and `<span data-api-lbl>`. Later tasks rely on none of this except the CSS media block started here.

- [ ] **Step 1: Add the tab bar markup**

In `index.html`, immediately before `</body>` (after the closing `</div>` of `.app`), add:

```html
<!-- Mobile bottom tab bar — hidden on desktop (see css @media 768px). -->
<nav class="tabbar" id="tabbar">
  <button class="tab-item active" id="tab-report"   onclick="showPage('report')"><span class="tab-ico">📝</span><span class="tab-lbl">Report</span></button>
  <button class="tab-item"        id="tab-template" onclick="showPage('template')"><span class="tab-ico">📋</span><span class="tab-lbl">Template</span></button>
  <button class="tab-item"        id="tab-setup"    onclick="showPage('setup')"><span class="tab-ico">⚙️</span><span class="tab-lbl">Setup</span></button>
  <button class="tab-item"        id="tab-history"  onclick="showPage('history')"><span class="tab-ico">🕓</span><span class="tab-lbl">History</span></button>
  <button class="tab-item"        id="tab-context"  onclick="showPage('context')"><span class="tab-ico">🔤</span><span class="tab-lbl">Context</span></button>
</nav>
```

- [ ] **Step 2: Tag the sidebar provider/API controls and add the mobile Setup block**

In `index.html` `.sidebar-bottom` (lines ~26-33), add data attributes (keep existing ids and onclicks):

```html
        <button class="lang-btn active" id="pAnthropic" data-provider-btn="anthropic" onclick="setProvider('anthropic')" style="flex:1;border-radius:var(--r-sm)">Anthropic</button>
        <button class="lang-btn"        id="pOpenRouter" data-provider-btn="openrouter" onclick="setProvider('openrouter')" style="flex:1;border-radius:var(--r-sm)">OpenRouter</button>
```
and
```html
      <button class="api-btn" id="apiBtn" data-api-btn onclick="promptKey()">
        <span id="apiIcon" data-api-icon>○</span><span id="apiLbl" data-api-lbl>Set API key</span>
      </button>
```

Then find the Setup page (`<div class="page" id="page-setup">`) and insert as its FIRST card (right after the `page-sub` div):

```html
      <!-- Mobile-only: provider + API key live in the sidebar on desktop. -->
      <div class="card mobile-only">
        <div class="card-head"><span class="card-title">AI provider &amp; key</span></div>
        <div class="card-body">
          <div style="display:flex;gap:4px;margin-bottom:8px">
            <button class="lang-btn active" data-provider-btn="anthropic" onclick="setProvider('anthropic')" style="flex:1;border-radius:var(--r-sm)">Anthropic</button>
            <button class="lang-btn" data-provider-btn="openrouter" onclick="setProvider('openrouter')" style="flex:1;border-radius:var(--r-sm)">OpenRouter</button>
          </div>
          <button class="api-btn" data-api-btn onclick="promptKey()">
            <span data-api-icon>○</span><span data-api-lbl>Set API key</span>
          </button>
        </div>
      </div>
```

- [ ] **Step 3: Make ui.js drive collections instead of single ids**

In `js/ui.js`, inside `showPage(n)` after the `.nav-item` loop (line 12), add:

```js
  document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
```

and after `if (nav)  nav.classList.add('active');` add:

```js
  const tab = document.getElementById('tab-' + n);
  if (tab) tab.classList.add('active');
```

Replace `setProvider` (js/ui.js:50-56) with:

```js
function setProvider(p, save = true) {
  provider = p;
  if (save) localStorage.setItem('bra_provider', p);
  document.querySelectorAll('[data-provider-btn]').forEach(b =>
    b.classList.toggle('active', b.dataset.providerBtn === p));
  updateApiBtn();
}
```

Replace `updateApiBtn` (js/ui.js:71-83) with:

```js
function updateApiBtn() {
  const name = provider === 'openrouter' ? 'OpenRouter key' : 'Anthropic key';
  document.querySelectorAll('[data-api-btn]').forEach(btn => {
    const icon = btn.querySelector('[data-api-icon]');
    const lbl  = btn.querySelector('[data-api-lbl]');
    if (apiKey) {
      if (icon) icon.textContent = '●';
      if (lbl)  lbl.textContent  = name + ' set';
      btn.classList.add('set');
    } else {
      if (icon) icon.textContent = '○';
      if (lbl)  lbl.textContent  = 'Set ' + name;
      btn.classList.remove('set');
    }
  });
}
```

(The old `#pAnthropic`/`#pOpenRouter`/`#apiBtn` ids remain in the HTML for any other references, but ui.js no longer needs them.)

- [ ] **Step 4: Add tabbar CSS and start the 768px media block**

In `css/styles.css`, REPLACE the whole `@media(max-width:580px){...}` line (line 197) with:

```css
/* ── Mobile bottom tab bar (hidden on desktop) ────────────────────────── */
.tabbar{display:none;position:fixed;left:0;right:0;bottom:0;z-index:900;background:var(--surface);border-top:0.5px solid var(--border);padding:4px 6px calc(4px + env(safe-area-inset-bottom));justify-content:space-around}
.tab-item{display:flex;flex-direction:column;align-items:center;gap:2px;flex:1;min-height:44px;background:none;border:none;border-radius:var(--r-sm);color:var(--muted);cursor:pointer;padding:4px 2px}
.tab-item.active{color:var(--accent);background:var(--accent-dim)}
.tab-ico{font-size:17px;line-height:1.2}
.tab-lbl{font-size:10px;font-family:'IBM Plex Mono',monospace;letter-spacing:.02em}
.mobile-only{display:none}

@media(max-width:768px){
  .sidebar{display:none}
  .tabbar{display:flex}
  .mobile-only{display:block}
  .page{padding:1rem 1rem calc(70px + env(safe-area-inset-bottom))}
}
```

(Layout/touch rules are appended inside this same media block in Task 2.)

- [ ] **Step 5: Verify**

Run: `node -e "new Function(require('fs').readFileSync('js/ui.js','utf8'))"`
Expected: no output (parses).

Manual: open the app (any static server or `docker compose up`), Chrome DevTools responsive mode at 375px — sidebar gone, tab bar visible, all five pages navigable, active tab tracks page; Setup shows the provider/key card and the key button reflects state; at 1200px — tab bar and mobile card invisible, sidebar unchanged, provider/key buttons still work.

- [ ] **Step 6: Commit**

```bash
git add index.html js/ui.js css/styles.css
git commit -m "feat(mobile): bottom tab bar navigation and mobile provider/key access"
```

---

### Task 2: Layout collapse and touch ergonomics at ≤768px

**Files:**
- Modify: `css/styles.css` (append rules inside the `@media(max-width:768px)` block created in Task 1)

**Interfaces:**
- Consumes: the `@media(max-width:768px)` block from Task 1; existing classes `.g2 .g3 .rg2 .af-grid .lwi-row .fb-row .fb-type .ctx-row .fields-list .field-row .voice-area .btn .btn-sm .nav-item`.
- Produces: nothing consumed later; final CSS state.

- [ ] **Step 1: Append the layout/touch rules**

Inside the `@media(max-width:768px){...}` block, after the `.page` rule, append:

```css
  /* layout collapse */
  .g2,.g3,.rg2{grid-template-columns:1fr}
  .af-grid{grid-template-columns:1fr 1fr}
  .lwi-row{grid-template-columns:1fr 1fr;grid-auto-rows:auto}
  .lwi-row input[placeholder],.lwi-row .lwi-title{grid-column:1 / -1}
  .fb-row{grid-template-columns:1fr 1fr}
  .fb-type{display:none}
  .ctx-row{grid-template-columns:1fr 28px}
  .ctx-row .ctx-aliases{grid-column:1 / 2}
  /* dense custom-fields table scrolls horizontally instead of crushing */
  .fields-list{overflow-x:auto}
  .field-row{min-width:560px}
  /* touch ergonomics */
  .btn{min-height:44px}
  .btn-sm{min-height:38px}
  .tab-item,.sub-tab{min-height:44px}
  input[type="text"],input[type="password"],input[type="url"],select,textarea{font-size:16px;min-height:44px}
  .voice-area{flex-wrap:wrap}
  .toast,.install-banner{bottom:calc(80px + env(safe-area-inset-bottom))}
```

Notes anchored to current CSS: `.res-actions` (css/styles.css:117), `.btn-row` (:74), `.res-top` (:101) and `.ex-head` (:120) already `flex-wrap:wrap` — no change needed. The `.lwi-title` selector matches the title input in linked-work-item rows rendered by JS; if the actual rendered input has no such class, keep only the two-column collapse (the row still wraps sanely) — do not invent HTML changes.

- [ ] **Step 2: Verify no desktop leakage**

Run: `grep -n "min-height:44px" css/styles.css` — every hit must be inside the `@media(max-width:768px)` block (or in `.tab-item`'s base rule, which is `display:none` on desktop).

Manual, DevTools at 375px: Setup page — Jira fields stack single-column, custom-fields list scrolls sideways, all buttons comfortably tappable, focusing an input does not zoom (16px); Report page — voice area wraps, generate button full-height; History — items expand and action buttons wrap; toast appears above the tab bar. At 1200px: everything identical to `main`.

- [ ] **Step 3: Commit**

```bash
git add css/styles.css
git commit -m "feat(mobile): collapse grids and enlarge touch targets at 768px"
```

---

### Task 3: Backend URL placeholder suggests current origin

**Files:**
- Modify: `js/config.js` (in `renderSetup`/config-load function where `sBackend` is populated — the line `document.getElementById('sBackend').value = cfg.backendUrl || '';` near the top of the file)

**Interfaces:**
- Consumes: `cfg.backendUrl` and the `#sBackend` input from the backend-integration work (already on this branch).
- Produces: nothing consumed later.

- [ ] **Step 1: Set the placeholder when served over http(s)**

Directly after the line `document.getElementById('sBackend').value = cfg.backendUrl || '';` in `js/config.js`, add:

```js
  // When the app is served by the backend itself (not file:// or a static
  // host), the origin IS the backend — suggest it so phone users can copy it.
  if (/^https?:$/.test(location.protocol)) {
    document.getElementById('sBackend').placeholder = location.origin;
  }
```

- [ ] **Step 2: Verify**

Run: `node -e "new Function(require('fs').readFileSync('js/config.js','utf8'))"`
Expected: no output.

Manual: served via `docker compose up` at `http://localhost:3000`, Setup → Backend URL placeholder reads `http://localhost:3000`. Opened as `file://`, the `location.protocol` test fails, so the placeholder keeps the static HTML attribute value — correct, unchanged behavior.

- [ ] **Step 3: Commit**

```bash
git add js/config.js
git commit -m "feat(mobile): suggest current origin as Backend URL placeholder"
```

---

### Task 4: README — phone/LAN usage and voice caveats

**Files:**
- Modify: `README.md` (add a subsection inside the "Self-hosted backend (Docker + MongoDB)" section, after the "Run it" part)

- [ ] **Step 1: Add the section**

Insert into `README.md` after the "Run it" subsection of the self-hosted backend section:

```markdown
### Use it from your phone (LAN)

The docker stack listens on all interfaces, so any device on your network
can use the app:

1. Find your computer's LAN IP — `ip addr` (Linux), `ipconfig` (Windows),
   or System Settings → Network (macOS). Say it's `192.168.1.42`.
2. On the phone, open `http://192.168.1.42:3000` in Chrome.
3. In **⚙️ Setup**, set **Backend URL** to that same address (the field's
   placeholder suggests it) and save.

The UI is fully mobile-friendly — navigation moves to a bottom tab bar.

**Voice input caveats on phones:**

- Chrome treats plain-HTTP LAN addresses as insecure and blocks the
  microphone there. To dictate on the phone anyway, open
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
  `http://192.168.1.42:3000`, and relaunch Chrome. Everything except the
  mic (typing, generating, history, Jira push) works without this.
- Voice input works in Chrome for Android; iOS Safari support is limited —
  typing always works.
- The floating dictation window (Batch) is desktop-Chrome-only; on phones
  the normal inline mic controls are used.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: phone/LAN usage and mobile voice caveats"
```

---

### Task 5: Request microphone permission on page load

**Files:**
- Modify: `js/voice.js` (append at end of file), `index.html` (no change needed — voice.js is already loaded)

**Interfaces:**
- Consumes: nothing from other tasks; browser APIs `navigator.permissions`, `navigator.mediaDevices.getUserMedia`, `window.isSecureContext`.
- Produces: nothing consumed later.

- [ ] **Step 1: Append the pre-warm function to js/voice.js**

```js
// ── proactive mic permission ──────────────────────────────────────────────
// Ask for the microphone once on page load so the first dictation tap
// doesn't stall on the browser prompt. Silent no-op when: insecure context
// (Chrome blocks mic on plain-HTTP LAN anyway), already granted/denied, or
// APIs unavailable. The per-tap flow in toggleRec() stays the fallback.
async function prewarmMicPermission() {
  if (!window.isSecureContext) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: 'microphone' });
      if (st.state !== 'prompt') return;           // granted or denied — nothing to ask
    } else {
      // No Permissions API: ask at most once per tab session.
      if (sessionStorage.getItem('bra_mic_prewarmed')) return;
      sessionStorage.setItem('bra_mic_prewarmed', '1');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());     // permission secured; release the device
  } catch (e) {
    console.warn('Mic permission pre-warm skipped:', e.name || e);
  }
}
document.addEventListener('DOMContentLoaded', prewarmMicPermission);
```

- [ ] **Step 2: Verify**

Run: `node -e "new Function(require('fs').readFileSync('js/voice.js','utf8'))"`
Expected: no output.

Manual: serve on `http://localhost:3000`, open in a fresh Chrome profile/incognito — the mic permission prompt appears on load; allow it; reload — no second prompt; tap the mic — recording starts without a permission prompt. On a plain-HTTP LAN origin — no prompt and no console error beyond the warn.

- [ ] **Step 3: Commit**

```bash
git add js/voice.js
git commit -m "feat(mobile): request microphone permission on page load"
```

---

### Task 6: Zero-config backend auto-detect + LAN address display

**Files:**
- Create: `server/routes/info.js`
- Test: `server/test/info.test.js`
- Modify: `server/app.js` (mount `/api/info`), `docker-compose.yml` + `.env.example` (optional `HOST_IP`), `js/config.js` (auto-detect + LAN hint), `js/history.js` (sync uses effective backend), `js/jira.js` (proxy priority), `index.html` (`#lanHint` div under the Backend URL field), `README.md` (Vercel-optional note)

**Interfaces:**
- Consumes: `createApp(db, { fetchImpl, env })`; existing `syncReportToBackend` in js/history.js; `proxyTarget` logic in js/jira.js `jiraRequest()`; `#sBackend` field in Setup.
- Produces: `GET /api/info` → `{ ok: true, lanIps: string[] }`; frontend globals `autoBackend` (string) and `effectiveBackendUrl()` (returns explicit `cfg.backendUrl` or `autoBackend`, trailing slashes stripped) defined in js/config.js.

- [ ] **Step 1: Write the failing server test**

`server/test/info.test.js`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { startMemoryMongo } from './helpers.js';

let mem;
before(async () => { mem = await startMemoryMongo(); });
after(() => mem.stop());

test('HOST_IP env takes precedence', async () => {
  const app = createApp(mem.db, { env: { HOST_IP: '10.0.0.9' } });
  const res = await request(app).get('/api/info');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, lanIps: ['10.0.0.9'] });
});

test('falls back to interface scan (array of strings)', async () => {
  const app = createApp(mem.db, { env: {} });
  const res = await request(app).get('/api/info');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.lanIps));
  res.body.lanIps.forEach(ip => assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/));
});
```

Run: `cd server && node --test test/info.test.js` — expect FAIL (404).

- [ ] **Step 2: Implement the route**

`server/routes/info.js`:
```js
import os from 'node:os';
import { Router } from 'express';

// LAN discovery: inside docker the container can't see the host's LAN IP,
// so HOST_IP (set in .env) wins; the interface scan covers bare `npm start`.
export function infoRouter({ env = process.env } = {}) {
  const r = Router();
  r.get('/', (_req, res) => {
    let lanIps = [];
    if (env.HOST_IP) {
      lanIps = [env.HOST_IP];
    } else {
      for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) {
          if (i.family === 'IPv4' && !i.internal) lanIps.push(i.address);
        }
      }
    }
    res.json({ ok: true, lanIps });
  });
  return r;
}
```

In `server/app.js`: `import { infoRouter } from './routes/info.js';` and mount `app.use('/api/info', infoRouter({ env }));` next to the other /api mounts.

Run: `cd server && npm test` — all green.

- [ ] **Step 3: Compose + env plumbing**

`docker-compose.yml` app environment: add `HOST_IP: ${HOST_IP:-}`.
`.env.example`, after the OPENROUTER lines:
```bash
# Your machine's LAN IP — shown in the app as the phone-access address.
# Find it with: hostname -I | awk '{print $1}'   (docker cannot autodetect it)
HOST_IP=
```

- [ ] **Step 4: Frontend auto-detect + LAN hint**

`index.html`: directly under the Backend URL field div, add:
```html
          <div id="lanHint" style="display:none;font-size:12px;font-family:'IBM Plex Mono',monospace;color:var(--muted);margin:-6px 0 12px"></div>
```

`js/config.js`, append at the end of the file:
```js
// ── zero-config backend detection ─────────────────────────────────────────
// When the page is served by our own Express backend (docker stack), adopt
// it automatically: reports sync and Jira pushes work with no Setup at all.
// Explicit cfg.backendUrl always wins over the auto-detected origin.
let autoBackend = '';

function effectiveBackendUrl() {
  return (cfg.backendUrl || autoBackend || '').trim().replace(/\/+$/, '');
}

async function detectBackend() {
  if (!/^https?:$/.test(location.protocol)) return;   // file:// → nothing to probe
  try {
    const r = await fetch('/health');
    const j = await r.json();
    if (j && j.ok) autoBackend = location.origin;
  } catch { /* static hosting — no backend here */ }
  renderLanHint();
}

// "📱 Phone access" link in Setup: LAN IP from the backend + our own port.
async function renderLanHint() {
  const el = document.getElementById('lanHint');
  const base = effectiveBackendUrl();
  if (!el || !base) return;
  try {
    const j = await (await fetch(base + '/api/info')).json();
    const ip = (j.lanIps || [])[0];
    if (!ip) return;
    const port = location.port ? ':' + location.port : '';
    const url = `http://${ip}${port}`;
    el.innerHTML = `📱 Phone access (LAN): <a href="${url}" style="color:var(--accent)">${url}</a>`;
    el.style.display = 'block';
  } catch { /* backend without /api/info or unreachable — keep hidden */ }
}

document.addEventListener('DOMContentLoaded', detectBackend);
```

`js/history.js` — in `syncReportToBackend`, replace
`const base = (cfg.backendUrl || '').trim().replace(/\/+$/, '');`
with
`const base = effectiveBackendUrl();`

`js/jira.js` — in `jiraRequest()`, replace the `backendJira`/`proxyTarget` lines with (priority: explicit backend → explicit proxy → auto backend):
```js
  const explicitBackend = (cfg.backendUrl || '').trim().replace(/\/+$/, '');
  const proxyTarget = explicitBackend ? explicitBackend + '/api/jira'
    : (cfg.proxyUrl || '').trim() ? cfg.proxyUrl.trim()
    : autoBackend ? autoBackend + '/api/jira'
    : '';
```

- [ ] **Step 5: README note**

In the Vercel deploy/proxy section add one line: "**Running the docker backend? Skip this section** — the backend serves the same proxy at `/api/jira` and the app uses it automatically." And in the self-hosted backend section mention `HOST_IP` in `.env` enables the in-app "📱 Phone access (LAN)" link.

- [ ] **Step 6: Verify**

`cd server && npm test` green; `node -e "new Function(require('fs').readFileSync('js/config.js','utf8'))"` and same for js/history.js, js/jira.js — parse.
Manual: docker stack (no Backend URL configured, no Vercel proxy) → generate report lands in Mongo; Setup shows the LAN link when HOST_IP is set; `file://` open → no probe errors in console.

- [ ] **Step 7: Commit**

```bash
git add server/routes/info.js server/test/info.test.js server/app.js docker-compose.yml .env.example index.html js/config.js js/history.js js/jira.js README.md
git commit -m "feat: zero-config backend auto-detect and LAN address display"
```

---

## Final verification (after all tasks)

1. `docker compose up -d --build`; open `http://localhost:3000`.
2. DevTools device emulation — iPhone SE (375px), Pixel 7 (412px), iPad (768px): navigate all five pages via the tab bar; generate flow reachable; Setup fully editable; custom-fields table scrolls; History expands; toast clears the tab bar.
3. Desktop window >768px: compare against `main` — no visual differences.
4. PiP degradation: in responsive mode, `documentPictureInPicture` is still defined in desktop Chrome, so real-phone check (or DevTools device emulation over LAN) confirms Batch falls back to inline mic without errors — `js/session.js:450` and `js/voice.js:307` already guard this; verify no unguarded PiP call throws with the API absent (search `documentPictureInPicture` — only guarded uses).
5. `cd server && npm test` still green (nothing server-side changed, sanity only).
6. Run superpowers:verification-before-completion, then superpowers:finishing-a-development-branch.
