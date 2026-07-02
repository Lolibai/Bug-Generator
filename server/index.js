import 'dotenv/config';
import { connectDb, ensureIndexes } from './db.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bugreports';

// Fail fast if Mongo is unreachable — compose restarts us until it's up.
const { db } = await connectDb(MONGODB_URI);
await ensureIndexes(db);

createApp(db).listen(PORT, () => {
  console.log(`Bug Report Agent server on :${PORT}`);
});
