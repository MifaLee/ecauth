import 'dotenv/config';
import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { parseBoolean, requiredEnv } from './env';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: requiredEnv('DATABASE_URL'),
  ssl: parseBoolean(process.env.DATABASE_SSL, false) ? { rejectUnauthorized: false } : undefined,
});

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}