import { Router } from 'express';

// LLM proxy so browsers need no key of their own: the server's .env key
// has top priority for the whole team. OpenRouter preferred over Anthropic.
function pickProvider(env) {
  if (env.OPENROUTER_API_KEY) {
    return { provider: 'openrouter', key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku' };
  }
  if (env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', key: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514' };
  }
  return null;
}

export function aiRouter({ fetchImpl = fetch, env = process.env } = {}) {
  const r = Router();

  r.get('/status', (_req, res) => {
    const p = pickProvider(env);
    res.json(p ? { available: true, provider: p.provider, model: p.model }
               : { available: false, provider: null, model: null });
  });

  r.post('/', async (req, res) => {
    const { system, user } = req.body || {};
    if (typeof system !== 'string' || typeof user !== 'string' || !system || !user) {
      return res.status(400).json({ error: 'system and user (strings) are required' });
    }
    const p = pickProvider(env);
    if (!p) return res.status(503).json({ error: 'No server AI key configured (.env OPENROUTER_API_KEY / ANTHROPIC_API_KEY)' });

    try {
      let upstream, data;
      if (p.provider === 'openrouter') {
        upstream = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key },
          body: JSON.stringify({
            model: p.model,
            max_tokens: 1600,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          }),
        });
        data = JSON.parse(await upstream.text());
        if (upstream.status < 200 || upstream.status >= 300) {
          return res.status(502).json({ error: data.error?.message || `OpenRouter HTTP ${upstream.status}` });
        }
        return res.json({ text: data.choices?.[0]?.message?.content || '' });
      }
      upstream = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: p.model,
          max_tokens: 1600,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      data = JSON.parse(await upstream.text());
      if (upstream.status < 200 || upstream.status >= 300) {
        return res.status(502).json({ error: data.error?.message || `Anthropic HTTP ${upstream.status}` });
      }
      return res.json({ text: (data.content || []).map(i => i.text || '').join('') });
    } catch (e) {
      return res.status(502).json({ error: 'AI upstream failed: ' + e.message });
    }
  });

  return r;
}
