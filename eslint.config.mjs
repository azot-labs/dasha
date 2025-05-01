import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default defineConfig([
  globalIgnores(['*.mjs', 'dist/', 'test/']),
  tseslint.config(tseslint.configs.strict, {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  }),
  {
    files: ['*.ts', 'lib/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  eslintPluginPrettierRecommended,
  {
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn'],
      '@typescript-eslint/no-explicit-any': ['warn'],
      '@typescript-eslint/no-non-null-assertion': ['warn'],
    },
  },
]);
