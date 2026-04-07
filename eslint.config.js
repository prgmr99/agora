// eslint.config.js — flat config, ESM
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Base recommended rules + TypeScript type-aware rules
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Project-specific overrides
  {
    rules: {
      // No unused variables — catch dead code early
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // No explicit any — legitimate BetterSqlite3.Statement<any[]> usages
      // in db.ts should use eslint-disable comments to remain intentional.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Prefer consistent type imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // No floating promises — MCP tool handlers are async; unhandled rejections
      // must be explicit.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // Ignore compiled output
  {
    ignores: ['dist/**', 'node_modules/**'],
  }
);
