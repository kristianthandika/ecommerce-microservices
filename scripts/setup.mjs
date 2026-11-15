import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) {
  console.log('.env already exists; left unchanged');
  process.exit(0);
}
const admin = process.argv.includes('--demo-admin');
writeFileSync(
  '.env',
  `INTERNAL_SERVICE_TOKEN=${randomBytes(32).toString('hex')}\nSEED_ADMIN_ENABLED=${admin}\nSEED_ADMIN_EMAIL=${admin ? 'admin@inixindo.local' : ''}\nSEED_ADMIN_PASSWORD=${admin ? randomBytes(24).toString('base64url') : ''}\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log('Created .env with random credentials. Keep this file private.');
