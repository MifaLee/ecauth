import 'dotenv/config';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { closePool, query } from '../lib/db';

async function main(): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
  const sql = await readFile(schemaPath, 'utf8');
  await query(sql);
  console.log('Database schema initialized');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });