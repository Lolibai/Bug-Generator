# Env-First Zero Setup + Connection Status — Design

**Date:** 2026-07-03
**Status:** Approved

## Goal

When `.env` provides the credentials, teammates open the LAN URL and use
everything — generation, Jira push, dictation — with zero UI setup. `.env`
has top priority, UI-provided values are the fallback. The UI clearly shows
that all services are OK and connected.

## Priority model (env → UI)

- **AI (LLM) calls** (`callAi`: generation, template analysis, transcript
  polish): if the backend reports a server key, route through the backend;
  otherwise use the browser-local key as today. Server env selection:
  `OPENROUTER_API_KEY` (with `OPENROUTER_MODEL`) preferred, else
  `ANTHROPIC_API_KEY` (model `anthropic/claude-sonnet-4-5` equivalent via
  Anthropic API `claude-sonnet-4-5`; env `ANTHROPIC_MODEL` overrides).
- **Jira proxy credentials**: `.env` (`JIRA_*`) → Mongo-stored (UI "Store on
  server") → request body (browser-local). This flips the current body-first
  order; a browser-typed token no longer overrides `.env` while env creds
  are set (accepted consequence).
- GPT-4o Transcribe remains browser-key-only (Local Whisper is the keyless
  transcription path).

## Backend

- `POST /api/ai` — body `{ system: string, user: string }` → `{ text }`.
  Uses the env key/provider above; 503 `{error}` when no server key; 502
  with upstream message on provider failure. Calls go through the
  injectable `fetchImpl`.
- `GET /api/ai/status` — `{ available: bool, provider: 'openrouter'|'anthropic'|null, model: string|null }`.
- `server/routes/jira.js`: resolution order becomes env → stored → body.
- `GET /api/settings/jira` adds `envConfigured: bool` (true when all three
  `JIRA_*` env vars set) and `source: 'env'|'server'|'none'`.
- `GET /health` unchanged (`{ok, mongo}`) — reused by the status card.

## Frontend

### callAi routing (js/ai.js)

`callAi(system, user)`: if `serverAi.available` (cached from
`/api/ai/status` during `detectBackend()`) → `POST <backend>/api/ai`;
else existing browser-key paths. Errors surface exactly like today's
provider errors.

### Connection status card (Setup, first card)

Rows, each ✓ green / ⚠ amber / ✕ red with a short detail string:

1. **Backend** — `effectiveBackendUrl()` reachable via `/health`
   (✕ "no backend — localStorage only" when absent; that's amber ⚠, not
   red, since the app still works standalone).
2. **Database** — `mongo` flag from the same `/health` response.
3. **AI** — server key (`/api/ai/status`: "server key · <provider>/<model>")
   ✓; else browser key present ✓ "this browser's key"; else ✕
   "no AI key — set in .env or sidebar".
4. **Jira** — source from `/api/settings/jira`
   (`env` → ".env", `server` → "stored on server", else browser fields /
   "not configured"), then a live `/myself` call through the proxy;
   ✓ only when authentication actually succeeds (shows account name),
   ⚠ "configured, not verified" if the check errors, ✕ when nothing
   configured.
5. **Whisper** — `/api/transcribe/status` → "✓ <model> · <device>" or
   ⚠ "service not running".

Refreshed when the Setup page opens and via a "↻ Check all" button.
All checks run in parallel; failures render as row states, never toasts.

### Aggregate status dot

A small dot next to the logo in the sidebar footer area and on the mobile
tab bar's Setup tab: green when Backend+Database+AI+Jira are all ✓, amber
when the app is usable but something is unverified/missing, red only when
generation is impossible (no AI key anywhere). Tooltip/title lists the
non-green rows. Computed from the same check results, cached per page load.

### Setup de-noising

- Sidebar API-key button: when the server key is active, shows
  "● Server key (.env)" and the prompt explains a personal key is only
  used if the server key is removed.
- Server-Jira status line reuses the card's Jira source string.

## Docs / env

- `.env.example`: add optional `ANTHROPIC_API_KEY=`, `ANTHROPIC_MODEL=`.
- README: "Team zero-setup via .env" subsection — table of vars
  (`JIRA_BASE_URL/EMAIL/API_TOKEN`, `OPENROUTER_API_KEY` or
  `ANTHROPIC_API_KEY`, `HOST_IP`, optional `WHISPER_*`) and the sentence:
  fill these, `docker compose up -d`, teammates need zero Setup.

## Error handling

- `/api/ai` upstream failures → 502 with the provider's message (surfaced
  by the existing generation error box).
- Status checks are best-effort: any fetch failure renders the row state;
  no check can block the app.

## Testing

- Server: supertest — `/api/ai` env-key selection (openrouter preferred,
  anthropic fallback, 503 none, 502 upstream error, request shape per
  provider), `/api/ai/status`, flipped Jira precedence (env beats stored
  beats body), `settings/jira` `envConfigured`/`source`.
- Frontend: parse checks + live docker smoke (status card rows against the
  running stack; generation round-trip using only the server key with
  localStorage cleared).

## Out of scope (YAGNI)

- Proxying GPT-4o audio transcription through the backend.
- Per-user server-side keys or auth.
- Persisting status history / alerting.
