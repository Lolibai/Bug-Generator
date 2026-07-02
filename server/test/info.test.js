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
