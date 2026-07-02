# Mobile-Friendly Frontend — Design

**Date:** 2026-07-02
**Status:** Approved (Option A — responsive retrofit)

## Goal

Full mobile parity for the Bug Report Agent: every page (Report incl. Batch,
Session, History, Template, Setup) is usable one-handed on a phone. Pure
CSS/HTML retrofit — no framework, no build step, single `css/styles.css`
stays the only stylesheet.

## Approach

Responsive retrofit with one main breakpoint at **768px** (covers phones and
narrow tablets). The existing `@media(max-width:580px)` rule's tweaks fold
into the new 768px block (the old rule is removed). Desktop rendering must be
pixel-identical to today.

## Components

### 1. Bottom tab bar navigation (≤768px)

- The sidebar (`.sidebar`) is hidden; a fixed bottom tab bar (`.tabbar`)
  shows the same nav items (icon + ~10px label), rendered as a sibling of
  `.app` in `index.html` reusing the existing page-switching handlers
  (same `onclick` targets as `.nav-item`s; active state kept in sync by the
  existing `showPage`-style logic via a shared class or duplicated toggling
  in `js/ui.js`).
- `padding-bottom: env(safe-area-inset-bottom)` on the bar; `.page` gets
  enough bottom padding (`calc(70px + env(safe-area-inset-bottom))`) so
  content never hides behind it.
- The sidebar's API-key button: on mobile an equivalent button appears at
  the top of the Setup page (hidden on desktop).
- Desktop (>768px): tab bar `display:none`, sidebar unchanged.

### 2. Layout collapse (≤768px)

- `.g2`, `.g3`, `.rg2` → single column.
- `.af-grid`, `.lwi-row`, `.fb-row`, `.ctx-row` → stacked/wrapped layouts
  (grid-template collapses to 1-2 columns; controls keep logical order).
- `.field-row` (dense 7-column custom-fields table) → stays a grid but
  inside an `overflow-x:auto` wrapper with a `min-width` so it scrolls
  horizontally instead of crushing.
- `.page` padding reduces to `1rem`; cards keep full width.
- Inline styles in `index.html`/JS templates that hard-block narrow layouts
  (fixed widths, non-wrapping flex rows on result actions) are moved to
  classes or given wrapping behavior. Only offenders are touched — no
  wholesale inline-style migration.

### 3. Touch & input ergonomics (≤768px)

- Buttons, nav/tab items, select/inputs: `min-height:44px`.
- Inputs/textareas/selects: `font-size:16px` (prevents iOS focus zoom).
- `.res-actions`, `.btn-row`, card-head control clusters: `flex-wrap:wrap`.
- History item rows: date/badges may wrap to a second line rather than
  truncate the summary to nothing.

### 4. Known degradations (documented in README, not fixed)

- The floating Picture-in-Picture dictation controller (Batch) is
  desktop-Chrome-only; mobile uses the normal inline mic controls. The
  PiP-launch button hides on mobile (feature-detect `documentPictureInPicture`
  already implicitly gates it; ensure the button hides when unsupported).
- Voice input works in Chrome for Android; iOS Safari support is limited —
  typing always works. One-line README note.

### 5. LAN access (stacked on the backend branch)

This work builds on `feature/express-mongo-backend` so phones use the
docker stack over LAN:

- `docker compose up -d` already publishes the app on `0.0.0.0:${PORT:-3000}`
  — reachable at `http://<host-ip>:3000` from any LAN device. No compose
  change needed.
- README gains a "Use it from your phone (LAN)" subsection: find the host IP
  (`ip addr` / `ipconfig`), open `http://<host-ip>:3000`, set Backend URL to
  the same origin.
- Frontend nicety: when the app is served by the backend (not `file://` or
  Vercel), the Setup "Backend URL" field's placeholder suggests
  `window.location.origin` so phone users can just copy it in.
- **Secure-context caveat (documented):** Chrome blocks the Web Speech API
  (mic) on plain-HTTP non-localhost origins. On a phone over LAN, dictation
  is unavailable unless the user enables
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure` for the host
  origin (README documents this). Typing, generation, history, analytics and
  Jira push all work regardless. HTTPS termination is out of scope.

## Error handling

Pure presentational change — no new failure modes. The tab bar reuses
existing navigation functions; if JS fails, behavior equals today's.

## Testing

- Manual: Chrome DevTools device emulation (iPhone SE 375px, Pixel 7,
  iPad 768px) across all five pages — navigate, generate (mock/manual),
  expand history, edit Setup fields, scroll the custom-fields table.
- Desktop regression: >768px window compared against `main` — no visual
  change expected.
- Real device (optional, user): open the docker-served app on LAN.

## Out of scope (YAGNI)

- PWA/manifest/offline work (sw.js untouched).
- Making PiP dictation work on mobile.
- Dark/light theme, typography, or visual redesign.
- Inline-style cleanup beyond what blocks responsiveness.
