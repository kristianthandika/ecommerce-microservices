import { ServiceDatabase } from '@ecommerce/storage';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const service = process.argv[2];
const directory = process.argv[3];
if (
  !service ||
  !['auth', 'product', 'order'].includes(service) ||
  !directory ||
  !process.env.DATA_DIR
) {
  throw new Error('Usage: DATA_DIR=/app/data node scripts/backup.ts auth|product|order /backup');
}
mkdirSync(directory, { recursive: true });
const db = new ServiceDatabase(service);
try {
  const path = join(
    directory,
    `${service}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
  );
  await db.backup(path);
  console.log(`Backup completed: ${path}`);
} finally {
  db.close();
}
