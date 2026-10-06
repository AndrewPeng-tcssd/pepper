const { MongoMemoryServer } = require('mongodb-memory-server');
const { createApp, connectMongo } = require('../server');

(async () => {
  const mongo = await MongoMemoryServer.create();
  const store = await connectMongo({ uri: mongo.getUri(), dbName: 'pepper_feature_preview' });
  const server = createApp(store, { mailer: null, publicUrl: 'http://localhost:3001' }).listen(3001);
  await new Promise(resolve => server.once('listening', resolve));
  await fetch('http://localhost:3001/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '675', password: 'preview123456' })
  });
  console.log('Feature preview ready at http://localhost:3001');
  async function stop() {
    await new Promise(resolve => server.close(resolve));
    await store.client.close();
    await mongo.stop();
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
