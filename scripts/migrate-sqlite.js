const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { connectMongo } = require('../mongo');

async function migrate(oldPath, store) {
  const oldDb = new Database(oldPath, { readonly: true, fileMustExist: true });
  try {
    const accounts = oldDb.prepare('SELECT username, email, password_hash, balance, last_claim_at, created_at FROM users').all();
    let added = 0;
    let skipped = 0;
    for (const account of accounts) {
      const result = await store.users.updateOne(
        { usernameKey: account.username.toLowerCase() },
        { $setOnInsert: {
          username: account.username,
          usernameKey: account.username.toLowerCase(),
          email: account.email.toLowerCase(),
          passwordHash: account.password_hash,
          balance: account.balance,
          lastClaimAt: account.last_claim_at,
          createdAt: new Date(account.created_at)
        } },
        { upsert: true }
      );
      if (result.upsertedCount) added += 1;
      else skipped += 1;
    }
    return { added, skipped };
  } finally {
    oldDb.close();
  }
}

async function main() {
  const oldPath = path.join(__dirname, '..', 'data', 'pepper.sqlite');
  if (!fs.existsSync(oldPath)) {
    console.log('No old SQLite database found. Nothing to migrate.');
    return;
  }
  const store = await connectMongo();
  try {
    const { added, skipped } = await migrate(oldPath, store);
    console.log(`Migration complete: ${added} account(s) added, ${skipped} already present.`);
    console.log('Existing users will need to log in again. The old SQLite file was kept as a backup.');
  } finally { await store.client.close(); }
}

if (require.main === module) main().catch(error => { console.error('Migration failed:', error.message); process.exitCode = 1; });
module.exports = { migrate };
