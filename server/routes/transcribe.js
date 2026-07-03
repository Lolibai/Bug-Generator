import { Router } from 'express';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Proxy to the whisper container. The multipart body is streamed through
// untouched (duplex:'half' is required by undici for request streams), so
// this route must be mounted BEFORE any body parser touches multipart —
// express.json() ignores multipart, so the global mount order is fine.
export function transcribeRouter({ fetchImpl = fetch, env = process.env } = {}) {
  const base = () => (env.WHISPER_URL || 'http://whisper:9000').replace(/\/+$/, '');
  const r = Router();

  r.post('/', async (req, res) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_AUDIO_BYTES) {
      return res.status(413).json({ error: 'Audio too large (max 25 MB)' });
    }
    try {
      const upstream = await fetchImpl(base() + '/transcribe', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' },
        body: req,
        duplex: 'half',
      });
      const text = await upstream.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      res.status(upstream.status).json(data);
    } catch {
      res.status(503).json({ error: 'Whisper service unavailable' });
    }
  });

  r.get('/status', async (_req, res) => {
    try {
      const upstream = await fetchImpl(base() + '/healthz');
      const data = JSON.parse(await upstream.text());
      res.json(data);
    } catch {
      res.json({ ok: false });
    }
  });

  return r;
}
