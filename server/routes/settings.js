import { Router } from 'express';

// Server-stored Jira credentials (Mongo `settings` collection, _id 'jira').
// The token is write-only from the API's perspective: GET/PUT responses
// only ever expose a tokenSet boolean.
export function settingsRouter(db, { env = process.env } = {}) {
  const col = db.collection('settings');
  const r = Router();

  const publicShape = doc => ({
    jiraUrl:   (doc && doc.jiraUrl)   || '',
    jiraEmail: (doc && doc.jiraEmail) || '',
    tokenSet:  !!(doc && doc.jiraToken),
  });

  r.get('/jira', async (_req, res, next) => {
    try {
      const envConfigured = !!(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
      const doc = await col.findOne({ _id: 'jira' });
      const shape = publicShape(doc);
      res.json({
        ...shape,
        envConfigured,
        source: envConfigured ? 'env' : (shape.tokenSet ? 'server' : 'none'),
      });
    }
    catch (e) { next(e); }
  });

  r.put('/jira', async (req, res, next) => {
    try {
      const { jiraUrl = '', jiraEmail = '', jiraToken } = req.body || {};
      const $set = {
        jiraUrl:   String(jiraUrl).trim().replace(/\/+$/, ''),
        jiraEmail: String(jiraEmail).trim(),
      };
      if (typeof jiraToken === 'string' && jiraToken.trim()) $set.jiraToken = jiraToken.trim();
      await col.updateOne({ _id: 'jira' }, { $set }, { upsert: true });
      res.json(publicShape(await col.findOne({ _id: 'jira' })));
    } catch (e) { next(e); }
  });

  return r;
}
