import { nodeConfig } from '@minidrama/config/eslint/node';

export default [
  {
    /* Prisma's generated client. Machine-written, regenerated on every schema
       change, and not ours to fix — linting it reports thousands of findings
       that no one can action. It is still typechecked, because the application
       imports its types. */
    ignores: ['src/generated/**'],
  },
  ...nodeConfig,
  {
    /* The seed is a command-line script. Its console output IS its interface —
       it reports what it wrote. `no-console` exists to keep stray debugging out
       of the server, where pino is the only logger; it has no business here. */
    files: ['prisma/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
