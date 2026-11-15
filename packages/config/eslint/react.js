import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { baseConfig } from './base.js';

/**
 * Shared React config for the admin dashboard and the mobile app.
 * `browserGlobals: false` drops DOM globals for React Native.
 */
export function reactConfig({ browserGlobals = true } = {}) {
  return [
    ...baseConfig,
    {
      languageOptions: {
        globals: {
          ...(browserGlobals ? globals.browser : {}),
          ...globals.es2023,
        },
        parserOptions: {
          ecmaFeatures: { jsx: true },
        },
      },
      plugins: {
        'react-hooks': reactHooks,
        'react-refresh': reactRefresh,
      },
      rules: {
        ...reactHooks.configs.recommended.rules,
        'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      },
    },
  ];
}

export default reactConfig;
