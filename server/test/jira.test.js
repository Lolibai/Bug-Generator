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
