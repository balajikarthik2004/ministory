/**
 * A resolver hook that lets Node load the app's TypeScript modules directly.
 *
 * Metro and `tsconfig`'s `"moduleResolution": "bundler"` both allow
 * extensionless relative imports (`./asset-url`). Node's ESM resolver does
 * not. Rather than adding `.ts` extensions throughout the app — which would
 * be writing the app around a verification script — this hook appends the
 * extension during resolution, for relative specifiers only.
 *
 * Paired with `--experimental-strip-types`, which removes the type syntax.
 * Nothing is transpiled and nothing is mocked: the modules that run here are
 * exactly the modules Metro bundles.
 *
 * Usage:  node --experimental-strip-types --import ./tools/node-ts-resolver.mjs <script>
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HAS_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs|json|node)$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.')) {
      const parent = context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href;
      const basePath = fileURLToPath(new URL(specifier, parent));

      /*
       * Extensionless, as Metro and `"moduleResolution": "bundler"` allow.
       * Used by the mobile app.
       */
      if (!HAS_EXTENSION.test(specifier)) {
        for (const candidate of [
          `${basePath}.ts`,
          `${basePath}.tsx`,
          `${basePath}/index.ts`,
          `${basePath}/index.tsx`,
        ]) {
          if (existsSync(candidate)) {
            return nextResolve(pathToFileURL(candidate).href, context);
          }
        }
      }

      /*
       * A `.js` specifier that resolves to a `.ts` file.
       *
       * The backend is NodeNext ESM, where TypeScript requires imports to
       * carry the extension of the *emitted* file — so `./harness.js` is
       * written in a file that only exists as `harness.ts`. `tsc` and `tsx`
       * both understand that; Node's bare resolver does not, and reports the
       * `.js` path as missing.
       *
       * Only applied when the `.js` genuinely does not exist, so a real
       * compiled file always wins.
       */
      if (specifier.endsWith('.js') && !existsSync(basePath)) {
        const asTs = `${basePath.slice(0, -3)}.ts`;
        if (existsSync(asTs)) {
          return nextResolve(pathToFileURL(asTs).href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
