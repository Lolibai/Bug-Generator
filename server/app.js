import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { reportsRouter } from './routes/reports.js';
import { analyticsRouter } from './routes/analytics.js';
import { jiraRouter } from './routes/jira.js';
import { infoRouter } from './routes/info.js';
import { settingsRouter } from './routes/settings.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Factory so tests can inject an in-memory db and a fake fetch.
export function createApp(db, { fetchImpl = fetch, env = process.env } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', async (_req, res) => {
    let mongo = false;
    try { await db.command({ ping: 1 }); mongo = true; } catch { /* stays false */ }
    res.json({ ok: true, mongo });
  });

  app.use('/api/reports', reportsRouter(db));
  app.use('/api/analytics', analyticsRouter(db, { fetchImpl, env }));
  app.use('/api/jira', jiraRouter({ fetchImpl, env, db }));
  app.use('/api/info', infoRouter({ env }));
  app.use('/api/settings', settingsRouter(db));

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
