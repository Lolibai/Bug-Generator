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
