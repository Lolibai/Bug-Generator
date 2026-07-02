import { Router } from 'express';

export function analyticsRouter(db) {
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

  return r;
}
