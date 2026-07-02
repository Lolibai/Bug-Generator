import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';

// Boots an in-memory mongod for one test file. Call stop() in after().
export async function startMemoryMongo() {
  const mongod = await MongoMemoryServer.create();
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  const db = client.db('bugreports-test');
  return {
    db,
    client,
    mongod,
    async stop() {
      await client.close();
      await mongod.stop();
    },
  };
}
