# Express + MongoDB Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional dockerized Express + MongoDB backend (`server/`) providing central report storage, analytics aggregation, and a self-hosted Jira proxy, wired into the frontend via a new "Backend URL" setting.

**Architecture:** A `server/` directory holds an Express app built by a testable factory `createApp(db, opts)`; `index.js` loads `.env`, connects Mongo, and boots it. Docker Compose runs `app` + `mongo:7`. The frontend syncs each generated report to the backend when `cfg.backendUrl` is set, and routes Jira pushes through `<backendUrl>/api/jira` in preference to `cfg.proxyUrl`. Nothing changes when `backendUrl` is empty.

**Tech Stack:** Node 20, Express 4, official `mongodb` driver 6, `dotenv`, `cors`. Tests: built-in `node --test`, `supertest`, `mongodb-memory-server`.

**Spec:** `docs/superpowers/specs/2026-07-02-express-mongo-backend-design.md`

## Global Constraints

- Node 20; `server/` has its own `package.json` (`"type": "module"`) — the repo root stays install-free.
- No Mongoose — official `mongodb` driver only.
- Jira proxy must keep the exact request/response contract of `api/jira.js` (envelope `{jiraUrl, jiraEmail, jiraToken, path, method, body}`, path allow-list `^\/rest\/api\/3\/(issue|myself|project|priority|field|search)`, upstream status passed through, `{ raw: text }` fallback for non-JSON).
- All API errors are JSON `{ error: "<message>" }`.
- Frontend behavior with `cfg.backendUrl` unset must be byte-identical to today.
- `.env` is gitignored (already covered by existing `.gitignore`: `.env`, `.env.*`, `!.env.example`).
- Run all server commands from `server/` (`cd server`).

## File Structure

```
server/
  package.json          # deps + "test": "node --test test/"
  index.js              # boot: dotenv, Mongo connect, createApp, listen
  app.js                # createApp(db, {fetchImpl}) — express factory, static + routes
  db.js                 # connectDb(uri) → { client, db }, ensureIndexes(db)
  routes/reports.js     # reportsRouter(db)
  routes/analytics.js   # analyticsRouter(db)
  routes/jira.js        # jiraRouter({ fetchImpl, env })
  test/helpers.js       # shared in-memory Mongo setup
  test/reports.test.js
  test/analytics.test.js
  test/jira.test.js
  Dockerfile
docker-compose.yml      # repo root
.env.example            # repo root
js/config.js            # modify: load/save backendUrl
js/history.js           # modify: syncReportToBackend()
js/jira.js              # modify: backend proxy preference
index.html              # modify: Backend URL field in Setup
README.md               # modify: backend section
```

---

### Task 1: Server scaffold, app factory, /health

**Files:**
- Create: `server/package.json`, `server/app.js`, `server/index.js`, `server/db.js`, `server/test/helpers.js`, `server/test/health.test.js`

**Interfaces:**
- Produces: `createApp(db, { fetchImpl } = {})` → Express app (from `app.js`); `connectDb(uri)` → `{ client, db }` and `ensureIndexes(db)` (from `db.js`); test helper `startMemoryMongo()` → `{ db, client, mongod, stop() }`.

- [ ] **Step 1: Create package.json and install deps**

`server/package.json`:
```json
{
  "name": "bug-report-agent-server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node index.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "mongodb": "^6.8.0"
  },
  "devDependencies": {
    "mongodb-memory-server": "^10.0.0",
    "supertest": "^7.0.0"
  }
}
```

Run: `cd server && npm install`
Expected: lockfile created, no errors.

- [ ] **Step 2: Write the failing test**

`server/test/helpers.js`:
```js
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

// Boots an in-memory mongod for one test file. Call stop() in after().
export async function startMemoryMongo() {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  const db = client.db('bugreports-test');
  return {
    db,
    client,
    mongod,
    async stop() {
      await client.close();
      await mongod.stop();
    },
  };
}
```

`server/test/health.test.js`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { startMemoryMongo } from './helpers.js';

let mem, app;
before(async () => {
  mem = await startMemoryMongo();
  app = createApp(mem.db);
});
after(() => mem.stop());

test('GET /health reports ok and mongo connectivity', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, mongo: true });
});

test('unknown /api route returns JSON 404', async () => {
  const res = await request(app).get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(typeof res.body.error, 'string');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — cannot find module `../app.js`.

- [ ] **Step 4: Implement db.js and app.js**

`server/db.js`:
```js
import { MongoClient } from 'mongodb';

export async function connectDb(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db() };
}

// Idempotent — safe to run on every startup.
export async function ensureIndexes(db) {
  const reports = db.collection('reports');
  await reports.createIndex({ createdAt: -1 });
  await reports.createIndex({ projectKey: 1, createdAt: -1 });
}
```

`server/app.js`:
```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { reportsRouter } from './routes/reports.js';
import { analyticsRouter } from './routes/analytics.js';
import { jiraRouter } from './routes/jira.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Factory so tests can inject an in-memory db and a fake fetch.
export function createApp(db, { fetchImpl = fetch } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', async (_req, res) => {
    let mongo = false;
    try { await db.command({ ping: 1 }); mongo = true; } catch { /* stays false */ }
    res.json({ ok: true, mongo });
  });

  app.use('/api/reports', reportsRouter(db));
  app.use('/api/analytics', analyticsRouter(db));
  app.use('/api/jira', jiraRouter({ fetchImpl }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the existing static frontend from the repo root.
  app.use(express.static(ROOT));

  // Last-resort error handler — keeps errors JSON.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message || 'Internal error' });
  });

  return app;
}
```

Stub the three routers so the module loads (they are implemented in Tasks 2–4):

`server/routes/reports.js`:
```js
import { Router } from 'express';
export function reportsRouter(_db) {
  return Router();
}
```

`server/routes/analytics.js`:
```js
import { Router } from 'express';
export function analyticsRouter(_db) {
  return Router();
}
```

`server/routes/jira.js`:
```js
import { Router } from 'express';
export function jiraRouter(_opts) {
  return Router();
}
```

`server/index.js`:
```js
import 'dotenv/config';
import { connectDb, ensureIndexes } from './db.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bugreports';

// Fail fast if Mongo is unreachable — compose restarts us until it's up.
const { db } = await connectDb(MONGODB_URI);
await ensureIndexes(db);

createApp(db).listen(PORT, () => {
  console.log(`Bug Report Agent server on :${PORT}`);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS (2 tests). First run downloads a mongod binary — allow a minute.

- [ ] **Step 6: Commit**

```bash
git add server/
git commit -m "feat(server): scaffold Express app factory with /health and Mongo indexes"
```

---

### Task 2: Reports CRUD routes

**Files:**
- Modify: `server/routes/reports.js` (replace stub)
- Test: `server/test/reports.test.js`

**Interfaces:**
- Consumes: `createApp(db)` from Task 1.
- Produces: `POST /api/reports` (stores body + `createdAt`, returns 201 with document incl. string `_id`); `GET /api/reports?projectKey=&from=&to=&limit=&skip=`; `GET /api/reports/:id`; `DELETE /api/reports/:id`. Report body must contain a non-empty string `summary`; `projectKey`, `format`, `severity`, `ticketKey`, `report` are stored as sent.

- [ ] **Step 1: Write the failing tests**

`server/test/reports.test.js`:
```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { startMemoryMongo } from './helpers.js';

let mem, app;
before(async () => {
  mem = await startMemoryMongo();
  app = createApp(mem.db);
});
after(() => mem.stop());
beforeEach(() => mem.db.collection('reports').deleteMany({}));

const sample = (over = {}) => ({
  summary: 'Cannot save bug',
  severity: 'High',
  format: 'normal',
  projectKey: 'QA',
  ticketKey: null,
  report: { summary: 'Cannot save bug', description: 'It breaks' },
  ...over,
});

test('POST stores a report and returns it with _id and createdAt', async () => {
  const res = await request(app).post('/api/reports').send(sample());
  assert.equal(res.status, 201);
  assert.equal(res.body.summary, 'Cannot save bug');
  assert.equal(typeof res.body._id, 'string');
  assert.ok(!Number.isNaN(Date.parse(res.body.createdAt)));
});

test('POST without summary is a 400', async () => {
  const res = await request(app).post('/api/reports').send({ severity: 'Low' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /summary/i);
});

test('GET lists newest first and filters by projectKey', async () => {
  await request(app).post('/api/reports').send(sample({ projectKey: 'QA', summary: 'first' }));
  await request(app).post('/api/reports').send(sample({ projectKey: 'OPS', summary: 'second' }));
  await request(app).post('/api/reports').send(sample({ projectKey: 'QA', summary: 'third' }));

  const all = await request(app).get('/api/reports');
  assert.equal(all.body.length, 3);
  assert.equal(all.body[0].summary, 'third');

  const qa = await request(app).get('/api/reports?projectKey=QA');
  assert.deepEqual(qa.body.map(r => r.summary), ['third', 'first']);
});

test('GET respects limit and skip', async () => {
  for (let i = 0; i < 5; i++) {
    await request(app).post('/api/reports').send(sample({ summary: `bug ${i}` }));
  }
  const page = await request(app).get('/api/reports?limit=2&skip=1');
  assert.deepEqual(page.body.map(r => r.summary), ['bug 3', 'bug 2']);
});

test('GET /:id returns the report, DELETE removes it', async () => {
  const created = await request(app).post('/api/reports').send(sample());
  const id = created.body._id;

  const got = await request(app).get(`/api/reports/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body._id, id);

  const del = await request(app).delete(`/api/reports/${id}`);
  assert.equal(del.status, 200);

  const gone = await request(app).get(`/api/reports/${id}`);
  assert.equal(gone.status, 404);
});

test('bad ObjectId is a 400, unknown id a 404', async () => {
  assert.equal((await request(app).get('/api/reports/not-an-id')).status, 400);
  assert.equal((await request(app).get('/api/reports/64b000000000000000000000')).status, 404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/reports.test.js`
Expected: FAIL — 404s from the stub router.

- [ ] **Step 3: Implement the router**

Replace `server/routes/reports.js`:
```js
import { Router } from 'express';
import { ObjectId } from 'mongodb';

const MAX_LIMIT = 200;

export function reportsRouter(db) {
  const col = db.collection('reports');
  const r = Router();

  r.post('/', async (req, res, next) => {
    try {
      const body = req.body || {};
      if (typeof body.summary !== 'string' || !body.summary.trim()) {
        return res.status(400).json({ error: 'summary (non-empty string) is required' });
      }
      const doc = { ...body, createdAt: new Date() };
      delete doc._id; // never trust a client-supplied id
      const { insertedId } = await col.insertOne(doc);
      res.status(201).json({ ...doc, _id: insertedId.toString() });
    } catch (e) { next(e); }
  });

  r.get('/', async (req, res, next) => {
    try {
      const { projectKey, from, to } = req.query;
      const limit = Math.min(Number(req.query.limit) || 50, MAX_LIMIT);
      const skip = Math.max(Number(req.query.skip) || 0, 0);
      const q = {};
      if (projectKey) q.projectKey = projectKey;
      if (from || to) {
        q.createdAt = {};
        if (from) q.createdAt.$gte = new Date(from);
        if (to) q.createdAt.$lte = new Date(to);
      }
      const docs = await col.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
      res.json(docs.map(d => ({ ...d, _id: d._id.toString() })));
    } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const doc = await col.findOne({ _id: new ObjectId(req.params.id) });
      if (!doc) return res.status(404).json({ error: 'Not found' });
      res.json({ ...doc, _id: doc._id.toString() });
    } catch (e) { next(e); }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { deletedCount } = await col.deleteOne({ _id: new ObjectId(req.params.id) });
      if (!deletedCount) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add server/routes/reports.js server/test/reports.test.js
git commit -m "feat(server): reports CRUD with filtering and pagination"
```

---

### Task 3: Analytics summary route

**Files:**
- Modify: `server/routes/analytics.js` (replace stub)
- Test: `server/test/analytics.test.js`

**Interfaces:**
- Consumes: `reports` collection documents from Task 2 (`projectKey`, `format`, `ticketKey`, `createdAt: Date`).
- Produces: `GET /api/analytics/summary?projectKey=&from=&to=` → `{ total, pushedToJira, byProject: [{key, count}], byFormat: [{key, count}], byCategory: [{key, count}], byDay: [{day: "YYYY-MM-DD", count}] }` (byDay ascending, others descending by count; reports without a `category` field appear under key `(uncategorized)`).

- [ ] **Step 1: Write the failing tests**

`server/test/analytics.test.js`:
```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { startMemoryMongo } from './helpers.js';

let mem, app;
before(async () => {
  mem = await startMemoryMongo();
  app = createApp(mem.db);
});
after(() => mem.stop());
beforeEach(() => mem.db.collection('reports').deleteMany({}));

async function seed() {
  await mem.db.collection('reports').insertMany([
    { summary: 'a', projectKey: 'QA',  format: 'normal',  ticketKey: 'QA-1', category: 'UI', createdAt: new Date('2026-07-01T10:00:00Z') },
    { summary: 'b', projectKey: 'QA',  format: 'gherkin', ticketKey: null,   createdAt: new Date('2026-07-01T11:00:00Z') },
    { summary: 'c', projectKey: 'OPS', format: 'normal',  ticketKey: null,   createdAt: new Date('2026-07-02T09:00:00Z') },
  ]);
}

test('summary aggregates totals, jira pushes, and breakdowns', async () => {
  await seed();
  const res = await request(app).get('/api/analytics/summary');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.pushedToJira, 1);
  assert.deepEqual(res.body.byProject[0], { key: 'QA', count: 2 });
  assert.deepEqual(res.body.byFormat.find(f => f.key === 'normal'), { key: 'normal', count: 2 });
  assert.deepEqual(res.body.byCategory.find(c => c.key === 'UI'), { key: 'UI', count: 1 });
  assert.deepEqual(res.body.byCategory.find(c => c.key === '(uncategorized)'), { key: '(uncategorized)', count: 2 });
  assert.deepEqual(res.body.byDay, [
    { day: '2026-07-01', count: 2 },
    { day: '2026-07-02', count: 1 },
  ]);
});

test('summary respects projectKey and date filters', async () => {
  await seed();
  const qa = await request(app).get('/api/analytics/summary?projectKey=QA');
  assert.equal(qa.body.total, 2);

  const day2 = await request(app).get('/api/analytics/summary?from=2026-07-02T00:00:00Z');
  assert.equal(day2.body.total, 1);
  assert.deepEqual(day2.body.byProject, [{ key: 'OPS', count: 1 }]);
});

test('summary on empty collection returns zeros', async () => {
  const res = await request(app).get('/api/analytics/summary');
  assert.deepEqual(res.body, { total: 0, pushedToJira: 0, byProject: [], byFormat: [], byCategory: [], byDay: [] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/analytics.test.js`
Expected: FAIL — 404 from the stub router.

- [ ] **Step 3: Implement the router**

Replace `server/routes/analytics.js`:
```js
import { Router } from 'express';

export function analyticsRouter(db) {
  const col = db.collection('reports');
  const r = Router();

  r.get('/summary', async (req, res, next) => {
    try {
      const { projectKey, from, to } = req.query;
      const match = {};
      if (projectKey) match.projectKey = projectKey;
      if (from || to) {
        match.createdAt = {};
        if (from) match.createdAt.$gte = new Date(from);
        if (to) match.createdAt.$lte = new Date(to);
      }

      // One pass over the filtered set; each facet is its own small pipeline.
      const [facets] = await col.aggregate([
        { $match: match },
        {
          $facet: {
            total: [{ $count: 'n' }],
            pushedToJira: [
              { $match: { ticketKey: { $type: 'string', $ne: '' } } },
              { $count: 'n' },
            ],
            byProject: [
              { $group: { _id: { $ifNull: ['$projectKey', '(none)'] }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byFormat: [
              { $group: { _id: { $ifNull: ['$format', 'normal'] }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byCategory: [
              { $group: { _id: { $ifNull: ['$category', '(uncategorized)'] }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byDay: [
              { $group: {
                  _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                  count: { $sum: 1 },
              } },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ]).toArray();

      const rename = arr => arr.map(({ _id, count }) => ({ key: _id, count }));
      res.json({
        total: facets.total[0]?.n || 0,
        pushedToJira: facets.pushedToJira[0]?.n || 0,
        byProject: rename(facets.byProject),
        byFormat: rename(facets.byFormat),
        byCategory: rename(facets.byCategory),
        byDay: facets.byDay.map(({ _id, count }) => ({ day: _id, count })),
      });
    } catch (e) { next(e); }
  });

  return r;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/analytics.js server/test/analytics.test.js
git commit -m "feat(server): analytics summary aggregation endpoint"
```

---

### Task 4: Jira proxy route

**Files:**
- Modify: `server/routes/jira.js` (replace stub)
- Test: `server/test/jira.test.js`

**Interfaces:**
- Consumes: `createApp(db, { fetchImpl })` injection from Task 1.
- Produces: `POST /api/jira` — identical contract to `api/jira.js`: envelope `{jiraUrl, jiraEmail, jiraToken, path, method='GET', body}`; credentials fall back to env `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` when omitted; allow-list `^\/rest\/api\/3\/(issue|myself|project|priority|field|search)`; upstream status + JSON passed through; non-JSON upstream → `{ raw: text }`; network failure → 502.

- [ ] **Step 1: Write the failing tests**

`server/test/jira.test.js`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { startMemoryMongo } from './helpers.js';

let mem;
before(async () => { mem = await startMemoryMongo(); });
after(() => mem.stop());

// fetchImpl stub factory: records the call, returns a canned upstream response.
function fakeFetch({ status = 200, body = '{"ok":true}', fail = false } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (fail) throw new Error('ECONNREFUSED');
    return { status, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const envelope = {
  jiraUrl: 'https://acme.atlassian.net/',
  jiraEmail: 'qa@acme.com',
  jiraToken: 'tok123',
  path: '/rest/api/3/myself',
};

test('proxies an allowed path with Basic auth and passes status through', async () => {
  const f = fakeFetch({ status: 200, body: '{"accountId":"abc"}' });
  const app = createApp(mem.db, { fetchImpl: f });
  const res = await request(app).post('/api/jira').send(envelope);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { accountId: 'abc' });
  assert.equal(f.calls[0].url, 'https://acme.atlassian.net/rest/api/3/myself');
  const auth = f.calls[0].opts.headers.Authorization;
  assert.equal(auth, 'Basic ' + Buffer.from('qa@acme.com:tok123').toString('base64'));
});

test('rejects paths outside the allow-list', async () => {
  const f = fakeFetch();
  const app = createApp(mem.db, { fetchImpl: f });
  const res = await request(app).post('/api/jira').send({ ...envelope, path: '/rest/api/3/user/search' });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('400 when credentials missing and no env fallback', async () => {
  const app = createApp(mem.db, { fetchImpl: fakeFetch() });
  const res = await request(app).post('/api/jira').send({ path: '/rest/api/3/myself' });
  assert.equal(res.status, 400);
});

test('env vars fill in missing credentials', async () => {
  const f = fakeFetch();
  const app = createApp(mem.db, {
    fetchImpl: f,
    env: { JIRA_BASE_URL: 'https://env.atlassian.net', JIRA_EMAIL: 'env@acme.com', JIRA_API_TOKEN: 'envtok' },
  });
  const res = await request(app).post('/api/jira').send({ path: '/rest/api/3/myself' });
  assert.equal(res.status, 200);
  assert.equal(f.calls[0].url, 'https://env.atlassian.net/rest/api/3/myself');
});

test('non-JSON upstream body becomes { raw }', async () => {
  const f = fakeFetch({ status: 403, body: '<html>Forbidden</html>' });
  const app = createApp(mem.db, { fetchImpl: f });
  const res = await request(app).post('/api/jira').send(envelope);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { raw: '<html>Forbidden</html>' });
});

test('upstream network failure is a 502', async () => {
  const app = createApp(mem.db, { fetchImpl: fakeFetch({ fail: true }) });
  const res = await request(app).post('/api/jira').send(envelope);
  assert.equal(res.status, 502);
});
```

Note: this adds an `env` option to `createApp` — thread it through to `jiraRouter` in `app.js` (Step 3).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/jira.test.js`
Expected: FAIL — 404 from the stub router.

- [ ] **Step 3: Implement the router and thread `env` through app.js**

Replace `server/routes/jira.js`:
```js
import { Router } from 'express';

// Same allow-list as api/jira.js (Vercel function) — keep them in sync.
const ALLOWED = /^\/rest\/api\/3\/(issue|myself|project|priority|field|search)/;

export function jiraRouter({ fetchImpl = fetch, env = process.env } = {}) {
  const r = Router();

  r.post('/', async (req, res) => {
    const b = req.body || {};
    const jiraUrl = b.jiraUrl || env.JIRA_BASE_URL;
    const jiraEmail = b.jiraEmail || env.JIRA_EMAIL;
    const jiraToken = b.jiraToken || env.JIRA_API_TOKEN;
    const { path, method = 'GET', body } = b;

    if (!jiraUrl || !jiraEmail || !jiraToken || !path) {
      return res.status(400).json({ error: 'Missing jiraUrl / jiraEmail / jiraToken / path' });
    }
    if (!ALLOWED.test(path)) {
      return res.status(400).json({ error: `Path "${path}" not in allow-list` });
    }

    const cleanUrl = String(jiraUrl).trim().replace(/\/+$/, '');
    const auth = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');

    try {
      const upstream = await fetchImpl(`${cleanUrl}${path}`, {
        method,
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await upstream.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      res.status(upstream.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'Proxy fetch failed: ' + e.message });
    }
  });

  return r;
}
```

In `server/app.js`, change the factory signature and jira mount:
```js
export function createApp(db, { fetchImpl = fetch, env = process.env } = {}) {
```
and
```js
  app.use('/api/jira', jiraRouter({ fetchImpl, env }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS (all test files).

- [ ] **Step 5: Commit**

```bash
git add server/routes/jira.js server/test/jira.test.js server/app.js
git commit -m "feat(server): self-hosted Jira proxy matching Vercel contract"
```

---

### Task 5: Docker, compose, .env.example

**Files:**
- Create: `server/Dockerfile`, `docker-compose.yml` (repo root), `.env.example` (repo root), `.dockerignore` (repo root — build context is the repo root)

**Interfaces:**
- Consumes: `server/index.js` boot from Task 1 (env vars `PORT`, `MONGODB_URI`, optional `JIRA_*`).
- Produces: `docker compose up` → app on `http://localhost:${PORT:-3000}` with persistent Mongo.

- [ ] **Step 1: Write Dockerfile and .dockerignore**

`server/Dockerfile` (build context is the repo root so the image contains the static frontend):
```dockerfile
FROM node:20-alpine
WORKDIR /app

# Server deps first for layer caching.
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# App code: static frontend at /app, server at /app/server.
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]
```

`.dockerignore` at repo root (the build context):
```
.git
node_modules
server/node_modules
docs
.env
.env.*
```

- [ ] **Step 2: Write docker-compose.yml**

`docker-compose.yml` (repo root):
```yaml
services:
  app:
    build:
      context: .
      dockerfile: server/Dockerfile
    ports:
      - "${PORT:-3000}:3000"
    environment:
      MONGODB_URI: mongodb://mongo:27017/bugreports
      JIRA_BASE_URL: ${JIRA_BASE_URL:-}
      JIRA_EMAIL: ${JIRA_EMAIL:-}
      JIRA_API_TOKEN: ${JIRA_API_TOKEN:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      OPENROUTER_MODEL: ${OPENROUTER_MODEL:-anthropic/claude-3.5-haiku}
    depends_on:
      mongo:
        condition: service_healthy
    restart: unless-stopped

  mongo:
    image: mongo:7
    volumes:
      - mongo-data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]
      interval: 5s
      timeout: 5s
      retries: 12
    restart: unless-stopped

volumes:
  mongo-data:
```

- [ ] **Step 3: Write .env.example**

`.env.example` (repo root):
```bash
# Copy to .env and adjust. Used by docker-compose and `node server/index.js`.

# Port the app is published on (host side).
PORT=3000

# Only needed when running the server OUTSIDE docker-compose
# (compose overrides this to point at the mongo service).
MONGODB_URI=mongodb://localhost:27017/bugreports

# Optional server-side Jira fallbacks for the /api/jira proxy.
# The browser-supplied credentials always take precedence.
JIRA_BASE_URL=
JIRA_EMAIL=
JIRA_API_TOKEN=

# Optional — enables POST /api/analytics/categorize (AI bug categorization).
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-3.5-haiku
```

- [ ] **Step 4: Verify the stack boots**

Run: `docker compose up --build -d && sleep 5 && curl -s http://localhost:3000/health`
Expected: `{"ok":true,"mongo":true}`

Then: `curl -s -X POST http://localhost:3000/api/reports -H 'Content-Type: application/json' -d '{"summary":"smoke test","projectKey":"QA","format":"normal"}'`
Expected: 201-style JSON with `_id`. And `curl -s http://localhost:3000/api/analytics/summary` shows `"total":1`.

Also verify the frontend is served: `curl -s http://localhost:3000/ | head -3` shows the index.html doctype.

Clean up: `docker compose down` (keep the volume).

- [ ] **Step 5: Commit**

```bash
git add server/Dockerfile .dockerignore docker-compose.yml .env.example
git commit -m "feat: dockerize server with mongo via docker-compose and .env.example"
```

---

### Task 6: Frontend — Backend URL setting + report sync + Jira routing

**Files:**
- Modify: `index.html` (Setup form, after the Proxy URL field at ~line 175-176)
- Modify: `js/config.js` (`loadCfgIntoForm` top section ~lines 3-9, `saveCfg()` at line 615)
- Modify: `js/history.js` (`addToHistory()` at line 44)
- Modify: `js/jira.js` (`jiraRequest()` at lines 71-116)

No JS test harness exists for the frontend (plain browser scripts, no npm at root) — verification is manual (Step 5), matching the project's existing practice.

- [ ] **Step 1: Add the Setup field**

In `index.html`, directly after the Proxy URL field div (line 176), add:
```html
          <div class="field"><label class="lbl">Backend URL <span style="color:var(--dim)">(optional — self-hosted server: central history + analytics + Jira proxy)</span></label>
            <input type="url" id="sBackend" placeholder="http://localhost:3000"/></div>
```

- [ ] **Step 2: Wire it into config load/save**

In `js/config.js`, after line 9 (`sProxy` load), add:
```js
  document.getElementById('sBackend').value = cfg.backendUrl || '';
```

In `saveCfg()` after the `cfg.proxyUrl` line (622), add:
```js
  cfg.backendUrl  = document.getElementById('sBackend').value.trim().replace(/\/+$/, '');
```

(Export/Import need no change — they serialize the whole `cfg` object, and `backendUrl` is not a secret.)

- [ ] **Step 3: Sync reports to the backend from addToHistory**

In `js/history.js`, add below `saveHistory()` and call it at the end of `addToHistory()`:
```js
// Fire-and-forget copy to the self-hosted backend (Setup → Backend URL).
// Never blocks or breaks the local flow — failures are console-only.
function syncReportToBackend(item) {
  const base = (cfg.backendUrl || '').trim().replace(/\/+$/, '');
  if (!base) return;
  fetch(base + '/api/reports', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary:    item.summary,
      severity:   item.severity,
      format:     item.format,
      projectKey: cfg.projectKey || null,
      ticketKey:  item.ticketKey,
      report:     item.report,
    }),
  }).catch(e => console.warn('Backend sync failed:', e));
}
```

In `addToHistory()`, restructure so the pushed item is shared:
```js
function addToHistory(report, format = reportFormat, ticketKey = null) {
  if (!report || !report.summary) return;
  const h = loadHistory();
  const item = {
    id:        Date.now(),
    date:      new Date().toLocaleString(),
    summary:   report.summary,
    severity:  report.severity || 'Medium',
    format:    format || 'normal',
    ticketKey: null,
    report:    report,
  };
  h.unshift(item);
  saveHistory(h);
  syncReportToBackend(item);
}
```

- [ ] **Step 4: Prefer the backend Jira proxy in jiraRequest**

In `js/jira.js`, inside `jiraRequest()`:

Replace line 81's guard:
```js
  const backendJira = cfg.backendUrl ? cfg.backendUrl.trim().replace(/\/+$/, '') + '/api/jira' : '';
  const proxyTarget = backendJira || (cfg.proxyUrl || '').trim();
  if (isCloud && !proxyTarget) {
```
(keep the existing `throw new Error(...)` body, but update the message's first suggestion to mention either option):
```js
    throw new Error(
      'Jira Cloud blocks direct browser requests (CORS). ' +
      'Set "Backend URL" (self-hosted server) or "Proxy URL" (Vercel) in Setup. ' +
      'See README.'
    );
```

Replace `if (cfg.proxyUrl) { res = await fetch(cfg.proxyUrl.trim(), {` (lines 91-92) with:
```js
  if (proxyTarget) {
    res = await fetch(proxyTarget, {
```
(the rest of the envelope body stays unchanged).

- [ ] **Step 5: Manual verification**

1. `docker compose up -d`, open `http://localhost:3000` in Chrome.
2. Setup → set Backend URL to `http://localhost:3000`, save. Reload — the field persists.
3. Generate a report (or stub: run `addToHistory({summary:'manual test', severity:'Low'})` in the console).
4. `curl -s http://localhost:3000/api/reports | head -c 400` — the report is there; `curl -s http://localhost:3000/api/analytics/summary` counts it.
5. Clear Backend URL, save, generate again — no request to the backend (check the Network tab), history still works locally.
6. If Jira is configured: Setup → "Test connection" succeeds with Backend URL set and Proxy URL empty.

- [ ] **Step 6: Commit**

```bash
git add index.html js/config.js js/history.js js/jira.js
git commit -m "feat(app): optional Backend URL — report sync and self-hosted Jira proxy"
```

---

### Task 7: README documentation

**Files:**
- Modify: `README.md` (add a "Self-hosted backend (Docker + MongoDB)" section after the Vercel/Push-to-Jira material; add the Backend URL setting to any Setup-field listing if present)

- [ ] **Step 1: Add the section**

Append a section to `README.md` (place it near the Jira proxy/Vercel deployment docs; adjust the anchor position to fit the actual README flow):
```markdown
## Self-hosted backend (Docker + MongoDB) — optional

Everything above works with zero install. Optionally, you can run a small
Express + MongoDB backend that adds:

- **Central report storage** — every generated report is also saved to
  MongoDB (shared across the team, not capped at 20 like local history)
- **Analytics** — `GET /api/analytics/summary` aggregates reports by
  project, format and day
- **Self-hosted Jira proxy** — `POST /api/jira`, same contract as the
  Vercel proxy, so no Vercel account is needed

### Run it

```bash
cp .env.example .env        # adjust if needed
docker compose up -d --build
```

Open `http://localhost:3000` — the backend serves the app itself — then in
**⚙️ Setup** set **Backend URL** to `http://localhost:3000` and save.
From now on every generated report is also stored centrally, and Jira
pushes go through the backend (Backend URL takes precedence over Proxy URL;
both remain configurable).

### API

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness + Mongo connectivity |
| `POST /api/reports` | store a report |
| `GET /api/reports?projectKey=&from=&to=&limit=&skip=` | list reports |
| `GET /api/analytics/summary?projectKey=&from=&to=` | totals, by project / format / day, Jira-push count |
| `POST /api/jira` | Jira proxy (same envelope as the Vercel function) |

### Development

```bash
cd server
npm install
npm test        # node --test with in-memory MongoDB
npm start       # needs MONGODB_URI (see .env.example)
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: self-hosted backend setup and API reference"
```

---

### Task 8: AI categorization of historical reports via OpenRouter

**Files:**
- Create: `server/lib/categorize.js`
- Modify: `server/routes/analytics.js` (add `POST /categorize`), `server/app.js` (pass `fetchImpl`/`env` to `analyticsRouter`)
- Test: `server/test/categorize.test.js`
- Modify: `README.md` (add categorize endpoint row to the API table; mention `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`)

**Interfaces:**
- Consumes: `createApp(db, { fetchImpl, env })` from Tasks 1/4; `reports` collection from Task 2; summary `byCategory` facet from Task 3.
- Produces: `CATEGORIES` const and `categorizeSummaries(summaries, { fetchImpl, env })` → `Promise<string[]>` (from `lib/categorize.js`); `POST /api/analytics/categorize?limit=` → `{ processed, remaining }`, 503 when `OPENROUTER_API_KEY` missing, 502 on upstream failure. `analyticsRouter(db, { fetchImpl, env })` gains a second options argument (defaulting to `{}`) — Task 3's call sites keep working.

- [ ] **Step 1: Write the failing tests**

`server/test/categorize.test.js`:
```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { startMemoryMongo } from './helpers.js';

let mem;
before(async () => { mem = await startMemoryMongo(); });
after(() => mem.stop());
beforeEach(() => mem.db.collection('reports').deleteMany({}));

const ENV = { OPENROUTER_API_KEY: 'sk-test', OPENROUTER_MODEL: 'test/model' };

// OpenRouter chat-completions stub. `answers` is the JSON array the model returns.
function fakeOpenRouter(answers, { status = 200, fail = false } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts: { ...opts, body: JSON.parse(opts.body) } });
    if (fail) throw new Error('ECONNREFUSED');
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify(answers) } }],
      }),
    };
  };
  fn.calls = calls;
  return fn;
}

async function seed(n) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    docs.push({ summary: `bug ${i}`, projectKey: 'QA', createdAt: new Date('2026-07-01T10:00:00Z') });
  }
  await mem.db.collection('reports').insertMany(docs);
}

test('categorizes uncategorized reports and persists categories', async () => {
  await seed(2);
  const f = fakeOpenRouter(['UI', 'Crash']);
  const app = createApp(mem.db, { fetchImpl: f, env: ENV });

  const res = await request(app).post('/api/analytics/categorize');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { processed: 2, remaining: 0 });

  const docs = await mem.db.collection('reports').find().sort({ summary: 1 }).toArray();
  assert.deepEqual(docs.map(d => d.category), ['UI', 'Crash']);
  assert.ok(docs.every(d => d.categorizedAt instanceof Date));

  // Request shape: auth header + model + summaries in the prompt.
  const call = f.calls[0];
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.opts.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.opts.body.model, 'test/model');
  assert.match(call.opts.body.messages[1].content, /bug 0/);
});

test('skips already-categorized reports and honors limit', async () => {
  await seed(3);
  await mem.db.collection('reports').updateOne({ summary: 'bug 0' }, { $set: { category: 'UI' } });
  const f = fakeOpenRouter(['Functional']);
  const app = createApp(mem.db, { fetchImpl: f, env: ENV });

  const res = await request(app).post('/api/analytics/categorize?limit=1');
  assert.deepEqual(res.body, { processed: 1, remaining: 1 });
});

test('invalid model category falls back to Other', async () => {
  await seed(1);
  const f = fakeOpenRouter(['Bananas']);
  const app = createApp(mem.db, { fetchImpl: f, env: ENV });
  await request(app).post('/api/analytics/categorize');
  const doc = await mem.db.collection('reports').findOne();
  assert.equal(doc.category, 'Other');
});

test('503 when no API key configured', async () => {
  const app = createApp(mem.db, { fetchImpl: fakeOpenRouter([]), env: {} });
  const res = await request(app).post('/api/analytics/categorize');
  assert.equal(res.status, 503);
  assert.match(res.body.error, /OPENROUTER_API_KEY/);
});

test('502 on OpenRouter failure, nothing persisted', async () => {
  await seed(1);
  const app = createApp(mem.db, { fetchImpl: fakeOpenRouter([], { fail: true }), env: ENV });
  const res = await request(app).post('/api/analytics/categorize');
  assert.equal(res.status, 502);
  const doc = await mem.db.collection('reports').findOne();
  assert.equal(doc.category, undefined);
});

test('200 with zero processed when nothing to categorize', async () => {
  const app = createApp(mem.db, { fetchImpl: fakeOpenRouter([]), env: ENV });
  const res = await request(app).post('/api/analytics/categorize');
  assert.deepEqual(res.body, { processed: 0, remaining: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/categorize.test.js`
Expected: FAIL — 404 (route missing).

- [ ] **Step 3: Implement lib/categorize.js**

`server/lib/categorize.js`:
```js
// Categorizes bug summaries in one OpenRouter chat request.
// Kept transport-injectable (fetchImpl) so tests never hit the network.

export const CATEGORIES = [
  'UI', 'Functional', 'Performance', 'Crash',
  'Data', 'Security', 'Integration', 'Other',
];

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function categorizeSummaries(summaries, { fetchImpl = fetch, env = process.env } = {}) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw Object.assign(new Error('OPENROUTER_API_KEY is not configured'), { status: 503 });

  const model = env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku';
  const res = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            `You classify bug reports. Allowed categories: ${CATEGORIES.join(', ')}. ` +
            'Reply with ONLY a JSON array of category strings, one per input bug, same order. No prose.',
        },
        {
          role: 'user',
          content: summaries.map((s, i) => `${i + 1}. ${s}`).join('\n'),
        },
      ],
      temperature: 0,
    }),
  });

  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw Object.assign(new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`), { status: 502 });
  }

  let cats;
  try {
    const content = JSON.parse(text).choices[0].message.content;
    // Tolerate markdown code fences around the JSON array.
    cats = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw Object.assign(new Error('OpenRouter returned unparseable content'), { status: 502 });
  }
  if (!Array.isArray(cats)) {
    throw Object.assign(new Error('OpenRouter did not return an array'), { status: 502 });
  }

  // One category per summary; anything off-list becomes 'Other'.
  return summaries.map((_, i) => (CATEGORIES.includes(cats[i]) ? cats[i] : 'Other'));
}
```

- [ ] **Step 4: Add the route and thread options through app.js**

In `server/routes/analytics.js`, change the signature and add the route (summary route from Task 3 is unchanged):
```js
import { Router } from 'express';
import { categorizeSummaries } from '../lib/categorize.js';

const MAX_BATCH = 50;

export function analyticsRouter(db, { fetchImpl = fetch, env = process.env } = {}) {
  const col = db.collection('reports');
  const r = Router();

  // ... existing GET /summary handler stays exactly as implemented in Task 3 ...

  r.post('/categorize', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || MAX_BATCH, MAX_BATCH);
      const docs = await col.find({ category: { $exists: false } })
        .sort({ createdAt: 1 }).limit(limit).toArray();

      if (!docs.length) return res.json({ processed: 0, remaining: 0 });

      const cats = await categorizeSummaries(docs.map(d => d.summary || ''), { fetchImpl, env });

      const now = new Date();
      await col.bulkWrite(docs.map((d, i) => ({
        updateOne: {
          filter: { _id: d._id },
          update: { $set: { category: cats[i], categorizedAt: now } },
        },
      })));

      const remaining = await col.countDocuments({ category: { $exists: false } });
      res.json({ processed: docs.length, remaining });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  return r;
}
```

In `server/app.js`, change the analytics mount:
```js
  app.use('/api/analytics', analyticsRouter(db, { fetchImpl, env }));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS — all test files, including the untouched summary tests.

- [ ] **Step 6: Update README**

In the README API table add:
```markdown
| `POST /api/analytics/categorize?limit=` | AI-categorize stored reports via OpenRouter (needs `OPENROUTER_API_KEY` in `.env`; categories: UI, Functional, Performance, Crash, Data, Security, Integration, Other) |
```

- [ ] **Step 7: Commit**

```bash
git add server/lib/categorize.js server/routes/analytics.js server/app.js server/test/categorize.test.js README.md
git commit -m "feat(server): AI categorization of stored reports via OpenRouter"
```

---

## Final verification (after all tasks)

1. `cd server && npm test` — all green.
2. `docker compose up --build -d` → `/health` returns `{"ok":true,"mongo":true}`.
3. Frontend smoke test per Task 6 Step 5.
4. Run the superpowers:verification-before-completion skill, then superpowers:finishing-a-development-branch.
