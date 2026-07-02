# Express + MongoDB Backend for Bug Report Agent — Design

**Date:** 2026-07-02
**Status:** Approved (Option A)

## Goal

Add an optional, dockerized Node.js/Express backend with MongoDB that gives the
Bug Report Agent central report storage, analytics over accumulated bug data,
and a self-hosted Jira proxy — **without replacing** the current
localStorage-only + Vercel-proxy workflow. The backend is configured per user
via a "Backend URL" setting; when unset, the app behaves exactly as today.

## Architecture

- New `server/` directory in this repo containing the Express app.
- `docker-compose.yml` at repo root runs two services:
  - `app` — `node:20-alpine`, runs the Express server, serves the existing
    static frontend (repo root) and the API.
  - `mongo` — `mongo:7` with a named volume `mongo-data` for persistence.
  - Healthchecks on both; `app` waits for `mongo` healthy.
- `Dockerfile` in `server/` (single stage, `npm ci --omit=dev`).
- Config via `dotenv`: `.env` (gitignored) + committed `.env.example` with:
  `PORT` (default 3000), `MONGODB_URI` (default
  `mongodb://mongo:27017/bugreports`), optional `JIRA_BASE_URL`,
  `JIRA_EMAIL`, `JIRA_API_TOKEN` fallbacks (frontend-supplied credentials
  still win, matching the Vercel proxy behavior).
- Dependencies: `express`, `mongodb` (official driver — aggregation-heavy
  workload, no Mongoose), `dotenv`, `cors`. Dev: `supertest`,
  `mongodb-memory-server`, `node:test` runner.

## Components

### 1. Express server (`server/`)

- `server/index.js` — bootstrap: load env, connect Mongo, mount routes,
  serve static frontend, start listener.
- `server/db.js` — Mongo client, database handle, index creation on startup
  (`reports`: `createdAt`, `projectKey`, compound `{projectKey, createdAt}`).
- `server/routes/reports.js` — CRUD for reports.
- `server/routes/analytics.js` — aggregation endpoints.
- `server/routes/jira.js` — Jira proxy, same request/response contract as
  `api/jira.js` (Vercel function) so the frontend switches only the base URL.

### 2. API endpoints

- `GET /health` — `{ ok: true, mongo: <connected?> }`.
- `POST /api/reports` — store a generated report. Body: the report object the
  frontend already builds for history (title, sections/fields, format
  `normal|gherkin`, `projectKey`, optional Jira issue key), server adds
  `_id` and `createdAt`. Returns the stored document.
- `GET /api/reports?projectKey=&from=&to=&limit=&skip=` — list, newest first,
  `limit` capped at 200.
- `GET /api/reports/:id`, `DELETE /api/reports/:id`.
- `GET /api/analytics/summary?projectKey=&from=&to=` — one aggregation
  response: total count, counts by projectKey, by format, by day
  (`createdAt` bucketed), and count pushed to Jira.
- `POST /api/jira` — proxy to Jira REST (create issue), mirroring
  `api/jira.js`.
- CORS enabled for all origins (team-internal, no auth — LAN/VPN deployment).

### 3. Frontend integration (minimal)

- Setup tab gains a **Backend URL** text field, stored in the existing config
  (`config.js`), included in Export/Import JSON.
- `history.js`: after a report is generated/saved locally, if Backend URL is
  set, `POST /api/reports` (fire-and-forget; failure logged to console, never
  blocks the local flow). Local 20-item history behavior unchanged.
- `jira.js` (frontend): if Backend URL is set, push to `<backend>/api/jira`;
  otherwise use the current Vercel path. Both remain configurable — this adds
  a target, it does not remove one.

## Data flow

Generate report → saved to localStorage history (unchanged) → if backend
configured, copy POSTed to `/api/reports` → MongoDB `reports` collection →
analytics endpoints run aggregation pipelines over it. Jira push goes through
whichever proxy the config selects.

## Error handling

- API returns JSON errors `{ error: <message> }` with proper status codes
  (400 invalid body/id, 404 not found, 502 Jira upstream failure with
  upstream body passed through, 500 otherwise).
- Server refuses to start without a reachable Mongo (fail fast; compose
  healthcheck ordering makes this reliable).
- Frontend sync failures are non-fatal: console warning only.

## Testing

- `node --test` + `supertest` against the Express app with
  `mongodb-memory-server` — covers reports CRUD, query filters, analytics
  aggregation shape, Jira proxy error mapping (Jira upstream mocked).
- Manual verification: `docker compose up`, generate a report with Backend
  URL set, confirm it lands in Mongo and appears in `/api/analytics/summary`.

## Out of scope (YAGNI)

- Authentication/accounts (team-internal deployment).
- Migrating existing localStorage history to the server.
- Removing/altering the Vercel proxy.
- Dashboards/UI for analytics (API only, for now).
