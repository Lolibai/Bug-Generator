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
