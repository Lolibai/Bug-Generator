import { Router } from 'express';
import { ObjectId } from 'mongodb';

const MAX_LIMIT = 200;

export function reportsRouter(db) {
  const col = db.collection('reports');
  const r = Router();

  r.post('/', async (req, res, next) => {
    try {
      const body = req.body || {};
      if (typeof body.summary !== 'string' || !body.summary.trim()) {
        return res.status(400).json({ error: 'summary (non-empty string) is required' });
      }
      const doc = { ...body, createdAt: new Date() };
      delete doc._id; // never trust a client-supplied id
      const { insertedId } = await col.insertOne(doc);
      res.status(201).json({ ...doc, _id: insertedId.toString() });
    } catch (e) { next(e); }
  });

  r.get('/', async (req, res, next) => {
    try {
      const { projectKey, from, to } = req.query;
      const limit = Math.min(Number(req.query.limit) || 50, MAX_LIMIT);
      const skip = Math.max(Number(req.query.skip) || 0, 0);
      const q = {};
      if (projectKey) q.projectKey = projectKey;
      if (from || to) {
        q.createdAt = {};
        if (from) q.createdAt.$gte = new Date(from);
        if (to) q.createdAt.$lte = new Date(to);
      }
      const docs = await col.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
      res.json(docs.map(d => ({ ...d, _id: d._id.toString() })));
    } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const doc = await col.findOne({ _id: new ObjectId(req.params.id) });
      if (!doc) return res.status(404).json({ error: 'Not found' });
      res.json({ ...doc, _id: doc._id.toString() });
    } catch (e) { next(e); }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const { deletedCount } = await col.deleteOne({ _id: new ObjectId(req.params.id) });
      if (!deletedCount) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}
