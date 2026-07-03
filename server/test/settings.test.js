import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../app.js';
import { startMemoryMongo } from './helpers.js';

let mem, app;
before(async () => {
  mem = await startMemoryMongo();
  app = createApp(mem.db, { env: {} });
});
after(() => mem.stop());
beforeEach(() => mem.db.collection('settings').deleteMany({}));

test('GET returns empty defaults', async () => {
  const res = await request(app).get('/api/settings/jira');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    jiraUrl: '', jiraEmail: '', tokenSet: false, envConfigured: false, source: 'none',
  });
});

test('PUT stores creds; token never echoed back', async () => {
  const res = await request(app).put('/api/settings/jira')
    .send({ jiraUrl: 'https://acme.atlassian.net/', jiraEmail: 'qa@acme.com', jiraToken: 'tok1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { jiraUrl: 'https://acme.atlassian.net', jiraEmail: 'qa@acme.com', tokenSet: true });
});

test('PUT with blank token keeps the stored token', async () => {
  await request(app).put('/api/settings/jira')
    .send({ jiraUrl: 'https://a.example.com', jiraEmail: 'a@a.com', jiraToken: 'keepme' });
  await request(app).put('/api/settings/jira')
    .send({ jiraUrl: 'https://b.example.com', jiraEmail: 'b@b.com', jiraToken: '' });
  const doc = await mem.db.collection('settings').findOne({ _id: 'jira' });
  assert.equal(doc.jiraToken, 'keepme');
  assert.equal(doc.jiraUrl, 'https://b.example.com');
});

test('GET reports source env when all JIRA_* env set', async () => {
  const envApp = createApp(mem.db, { env: { JIRA_BASE_URL: 'https://e.x', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' } });
  const res = await request(envApp).get('/api/settings/jira');
  assert.equal(res.body.envConfigured, true);
  assert.equal(res.body.source, 'env');
});

test('GET reports source server when stored token exists and env empty', async () => {
  await request(app).put('/api/settings/jira')
    .send({ jiraUrl: 'https://a.x', jiraEmail: 'a@a.a', jiraToken: 'tok' });
  const res = await request(app).get('/api/settings/jira');
  assert.equal(res.body.envConfigured, false);
  assert.equal(res.body.source, 'server');
});

test('GET reports source none when nothing configured', async () => {
  const res = await request(app).get('/api/settings/jira');
  assert.equal(res.body.source, 'none');
});
