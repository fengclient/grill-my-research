import { readFile } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw Error('Explicit DATABASE_URL required.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(918229904)');
  for (const migration of ['001-paid-orders.sql','002-quote-rate-limit.sql']) {
    await client.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  await client.query('COMMIT');
  console.log('Paid order schema ready.');
} catch {
  await client.query('ROLLBACK');
  console.error('Paid order migration failed.');
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }
