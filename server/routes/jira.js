import { Router } from 'express';

// Same allow-list as api/jira.js (Vercel function) — keep them in sync.
const ALLOWED = /^\/rest\/api\/3\/(issue|myself|project|priority|field|search)/;

export function jiraRouter({ fetchImpl = fetch, env = process.env } = {}) {
  const r = Router();

  r.post('/', async (req, res) => {
    const b = req.body || {};
    const jiraUrl = b.jiraUrl || env.JIRA_BASE_URL;
    const jiraEmail = b.jiraEmail || env.JIRA_EMAIL;
    const jiraToken = b.jiraToken || env.JIRA_API_TOKEN;
    const { path, method = 'GET', body } = b;

    if (!jiraUrl || !jiraEmail || !jiraToken || !path) {
      return res.status(400).json({ error: 'Missing jiraUrl / jiraEmail / jiraToken / path' });
    }
    if (!ALLOWED.test(path)) {
      return res.status(400).json({ error: `Path "${path}" not in allow-list` });
    }

    const cleanUrl = String(jiraUrl).trim().replace(/\/+$/, '');
    const auth = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');

    try {
      const upstream = await fetchImpl(`${cleanUrl}${path}`, {
        method,
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await upstream.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      res.status(upstream.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'Proxy fetch failed: ' + e.message });
    }
  });

  return r;
}
