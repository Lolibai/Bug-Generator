import { Router } from 'express';
import { categorizeSummaries } from '../lib/categorize.js';

const MAX_BATCH = 50;

export function analyticsRouter(db, { fetchImpl = fetch, env = process.env } = {}) {
  const col = db.collection('reports');
  const r = Router();

  r.get('/summary', async (req, res, next) => {
    try {
      const { projectKey, from, to } = req.query;
      const match = {};
      if (projectKey) match.projectKey = projectKey;
      if (from || to) {
        match.createdAt = {};
        if (from) match.createdAt.$gte = new Date(from);
        if (to) match.createdAt.$lte = new Date(to);
      }

      // One pass over the filtered set; each facet is its own small pipeline.
      const [facets] = await col.aggregate([
        { $match: match },
        {
          $facet: {
            total: [{ $count: 'n' }],
            pushedToJira: [
              { $match: { ticketKey: { $type: 'string', $ne: '' } } },
              { $count: 'n' },
            ],
            byProject: [
              { $group: { _id: { $ifNull: ['$projectKey', '(none)'] }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byFormat: [
              { $group: { _id: { $ifNull: ['$format', 'normal'] }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byCategory: [
              { $group: { _id: { $ifNull: ['$category', '(uncategorized)'] }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byDay: [
              { $group: {
                  _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                  count: { $sum: 1 },
              } },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ]).toArray();

      const rename = arr => arr.map(({ _id, count }) => ({ key: _id, count }));
      res.json({
        total: facets.total[0]?.n || 0,
        pushedToJira: facets.pushedToJira[0]?.n || 0,
        byProject: rename(facets.byProject),
        byFormat: rename(facets.byFormat),
        byCategory: rename(facets.byCategory),
        byDay: facets.byDay.map(({ _id, count }) => ({ day: _id, count })),
      });
    } catch (e) { next(e); }
  });

  r.post('/categorize', async (req, res, next) => {
    try {
      if (!env.OPENROUTER_API_KEY) {
        return res.status(503).json({ error: 'OPENROUTER_API_KEY is not configured' });
      }
      const limit = Math.min(Number(req.query.limit) || MAX_BATCH, MAX_BATCH);
      const docs = await col.find({ category: { $exists: false } })
        .sort({ createdAt: 1 }).limit(limit).toArray();

      if (!docs.length) return res.json({ processed: 0, remaining: 0 });

      const cats = await categorizeSummaries(docs.map(d => d.summary || ''), { fetchImpl, env });

      const now = new Date();
      await col.bulkWrite(docs.map((d, i) => ({
        updateOne: {
          filter: { _id: d._id },
          update: { $set: { category: cats[i], categorizedAt: now } },
        },
      })));

      const remaining = await col.countDocuments({ category: { $exists: false } });
      res.json({ processed: docs.length, remaining });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  return r;
}
