import { reactConfig } from '@minidrama/config/eslint/react';

export default [
  ...reactConfig({ browserGlobals: false }),
  {
    languageOptions: {
      globals: {
        __DEV__: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
  },
];
