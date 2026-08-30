import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const useSsl = process.env.DATABASE_SSL === 'true' || /[?&]sslmode=require(?:&|$)/.test(databaseUrl || '');

export const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

export async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
