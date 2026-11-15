import { baseConfig } from './eslint/base.js';

export default [
  ...baseConfig,
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'module', ecmaVersion: 2023 },
  },
];
