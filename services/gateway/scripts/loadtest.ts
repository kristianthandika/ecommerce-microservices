import autocannon from 'autocannon';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load test ringan (m3.3) ke gateway pakai autocannon. Target default
 * `/products` (publik, melewati proxy → product-service). Hasil ringkasan
 * disimpan ke file.
 */
const base = process.env.GATEWAY_URL || 'http://localhost:8080';
const path = process.env.LOADTEST_PATH || '/products';
const url = `${base}${path}`;

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log(`Menjalankan load test ke ${url} ...`);

const instance = autocannon(
  {
    url,
    connections: Number(process.env.LOADTEST_CONNECTIONS || 10),
    duration: Number(process.env.LOADTEST_DURATION || 10),
  },
  (err, result) => {
    if (err) {
      console.error('Load test gagal:', err.message);
      process.exit(1);
    }
    const summary = autocannon.printResult(result);
    const outFile = join(__dirname, '..', `loadtest-${Date.now()}.txt`);
    writeFileSync(outFile, summary);
    console.log(summary);
    console.log('Ringkasan disimpan ke', outFile);
  },
);

autocannon.track(instance, { renderProgressBar: true });
