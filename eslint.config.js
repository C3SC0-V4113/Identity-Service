import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'prisma.config.ts',
            'prisma/seed.ts',
            'prisma/bootstrap-project-admin.ts',
            'vitest.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: [
      'src/**/*.repositories.ts',
      'src/shared/auth/session-auth.ts',
      'src/shared/db/prisma.ts',
      'src/shared/db/prisma-client.ts',
      'src/modules/auth/auth.services.ts',
      'src/modules/identity/bootstrap/project-seed.ts',
      'src/modules/project-memberships/project-memberships.services.ts',
      'src/modules/project-memberships/project-memberships.guards.ts',
      'src/modules/project-memberships/project-memberships.routes.ts',
      'src/modules/identity/bootstrap/project-admin-bootstrap.ts',
      'prisma/bootstrap-project-admin.ts',
      'src/**/*.test.ts',
    ],
    rules: {
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
);
