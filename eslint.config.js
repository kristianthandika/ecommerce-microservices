import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Flat config dipakai seluruh workspace (ESLint 9 + typescript-eslint). */
export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
  {
    // Aturan yang butuh informasi tipe, hanya untuk berkas yang tercakup tsconfig.
    // Promise yang tidak di-await adalah cara error (dan penolakan yang seharusnya
    // menggagalkan request) hilang tanpa jejak; `void` menandai yang memang disengaja.
    files: [
      'services/*/src/**/*.ts',
      'services/*/tests/**/*.ts',
      'services/gateway/scripts/**/*.ts',
      'packages/*/src/**/*.ts',
      'frontend/src/**/*.{ts,tsx}',
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // Atribut JSX (onSubmit={async ...}) dikecualikan: React mengabaikan nilai
      // kembaliannya dan handler-nya menangani error sendiri.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    // Server tiruan di tes memakai listener async; penolakan di sana sudah muncul
    // sebagai tes gagal (unhandled rejection), jadi aturan ini tidak menambah apa-apa.
    files: ['**/tests/**/*.ts', 'frontend/src/test/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-misused-promises': 'off' },
  },
);
