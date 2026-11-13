import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(project, 'docs/materi-lanjutan');
const outputDirectory = resolve(project, '../materi/tambahan-fitur');
mkdirSync(outputDirectory, { recursive: true });

function prepare(filename) {
  const source = resolve(sourceDirectory, filename);
  const lines = readFileSync(source, 'utf8').split(/\r?\n/);
  let fence = null;
  return lines
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (marker) {
        if (fence === null) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const shifted = line.replace(/^(#{1,5}) /, '#$1 ');
      return shifted.replace(/(\[[^\]\n]*\]\()([^\s)]+)(\))/g, (_match, prefix, target, suffix) => {
        if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return `${prefix}${target}${suffix}`;
        const [path, ...fragment] = target.split('#');
        const relocated = relative(outputDirectory, resolve(dirname(source), path)).replaceAll(
          '\\',
          '/',
        );
        return `${prefix}${relocated}${fragment.length ? `#${fragment.join('#')}` : ''}${suffix}`;
      });
    })
    .join('\n')
    .trim();
}

const packs = [
  {
    output: 'materi-tambahan.md',
    title: 'Materi Tambahan — Alur Belanja dan Penguatan E-Commerce Microservices',
    audience:
      'Peserta pelatihan; sumber acuan 13 November 2026; tambahan 12 jam efektif setelah modul dasar.',
    files: [
      '01-modul-peserta.md',
      '02-praktikum.md',
      '03-referensi-api.md',
      '05-peta-kode-dan-pengujian.md',
      '07-keamanan-api-owasp.md',
    ],
  },
  {
    output: 'panduan-pengajar.md',
    title: 'Panduan Pengajar — Paket Fitur Lanjutan E-Commerce Microservices',
    audience:
      'Instruktur/editor; berisi jawaban acuan dan rubrik, pisahkan dari handout peserta bila diperlukan.',
    files: ['04-panduan-instruktur.md', '06-panduan-integrasi-materi.md'],
  },
];

for (const pack of packs) {
  const preface = `# ${pack.title}\n\n${pack.audience}\n\nBerkas gabungan dihasilkan oleh scripts/build-training-materials.mjs. Edit sumber kanonis pada ecommerce-microservices/docs/materi-lanjutan lalu regenerasi. Dokumen ini tidak berisi kredensial aktual dan belum merupakan hasil ekspor Word/PDF.\n\n`;
  writeFileSync(
    resolve(outputDirectory, pack.output),
    `${preface}${pack.files.map(prepare).join('\n\n---\n\n')}\n`,
    'utf8',
  );
  console.log(
    `Generated ${relative(project, resolve(outputDirectory, pack.output)).replaceAll('\\', '/')}`,
  );
}
