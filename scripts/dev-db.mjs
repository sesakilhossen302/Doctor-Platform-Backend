/**
 * Local development PostgreSQL without installing anything.
 *   npm run db:dev
 * Starts a portable PostgreSQL on port 5432 (user/password: postgres/postgres),
 * stores data in Backend/.pgdata, and creates the `doctor_platform` database.
 * Keep this terminal open; press Ctrl+C to stop.
 *
 * Production must use a managed PostgreSQL (see README).
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const dataDir = fileURLToPath(new URL('../.pgdata', import.meta.url));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: 5432,
  persistent: true,
  // UTF-8 is required for Bangla text (Windows otherwise defaults to WIN1252).
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

const fresh = !existsSync(dataDir);
if (fresh) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('doctor_platform');
} catch {
  /* already exists */
}
console.log('\n✔ PostgreSQL ready on localhost:5432 (database: doctor_platform)');
if (fresh) console.log('  First run: in another terminal run  npm run setup  to create tables and demo data.\n');

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
