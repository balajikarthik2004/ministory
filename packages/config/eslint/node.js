import globals from 'globals';
import { baseConfig } from './base.js';

/**
 * Node/Express config, including the module-boundary rule that keeps the
 * backend a modular monolith rather than a ball of mud (SYSTEM_ARCHITECTURE.md §2).
 *
 * A module may expose its service layer to other modules. Its repository layer
 * is private. Enforcing that in the linter is the difference between an
 * architecture and an intention.
 */
export const nodeConfig = [
  ...baseConfig,
  {
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*/*.repository', '**/modules/*/*.repository.*'],
              message:
                "Repositories are module-private. Import the owning module's service instead (SYSTEM_ARCHITECTURE.md §2).",
            },
            {
              group: ['../../../../*'],
              message:
                'Import reaches four levels up. Move the shared code into src/utils, src/services, or a workspace package.',
            },
          ],
        },
      ],
    },
  },
];

export default nodeConfig;
