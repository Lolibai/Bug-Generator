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
