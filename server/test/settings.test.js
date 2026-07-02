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
  assert.deepEqual(res.body, { jiraUrl: '', jiraEmail: '', tokenSet: false });
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
