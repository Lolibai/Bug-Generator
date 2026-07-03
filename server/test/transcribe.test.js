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
