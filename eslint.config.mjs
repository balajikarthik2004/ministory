import { baseConfig } from './packages/config/eslint/base.js';

/**
 * Root config. Each app and package has its own eslint.config.mjs; this one
 * covers loose files at the repository root.
 */
export default [
  {
    ignores: ['apps/**', 'packages/**', 'node_modules/**', '.turbo/**', 'docs/**'],
  },
  ...baseConfig,
];
