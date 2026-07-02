import { MongoClient } from 'mongodb';

export async function connectDb(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db() };
}

// Idempotent — safe to run on every startup.
export async function ensureIndexes(db) {
  const reports = db.collection('reports');
  await reports.createIndex({ createdAt: -1 });
  await reports.createIndex({ projectKey: 1, createdAt: -1 });
}
