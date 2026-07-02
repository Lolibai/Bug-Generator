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
