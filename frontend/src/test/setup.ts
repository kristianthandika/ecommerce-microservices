import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

// Matcher jest-dom didaftarkan pada `expect` yang di-import DI FILE INI — instance
// yang sama dengan yang dipakai file tes.
//
// Entry siap-pakai `@testing-library/jest-dom/vitest` meng-import 'vitest' dari
// dalam node_modules. Di Windows, bila huruf drive direktori kerja berbeda
// kapitalisasi dari path asli (terminal VS Code memakai `c:\`), modul 'vitest'
// termuat DUA kali, matcher terpasang di instance yang salah, dan semua tes gagal
// dengan "Invalid Chai property: toBeInTheDocument".
expect.extend(matchers);
