import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DevelopmentIdentityProvider, NullIdentityProvider } from '../src/services/identity.js';

/**
 * The development identity provider's guards.
 *
 * These are pure unit tests with no database and no server: the whole point
 * is the construction-time refusal, which happens before anything is wired
 * up. They are the tests that would catch somebody deleting the production
 * check during a refactor.
 */

const TOKEN = 'dev_token_for_tests';
const USER = 'user_seed_test';

describe('DevelopmentIdentityProvider', () => {
  it('resolves the configured user for the right token', async () => {
    const provider = new DevelopmentIdentityProvider(TOKEN, USER);
    const caller = await provider.resolve({ authorization: `Bearer ${TOKEN}` });

    assert.equal(caller?.userId, USER);
    assert.equal(caller?.isDevelopmentIdentity, true);
  });

  it('accepts the token through the dedicated header too', async () => {
    const provider = new DevelopmentIdentityProvider(TOKEN, USER);
    const caller = await provider.resolve({ 'x-minidrama-dev-user': TOKEN });
    assert.equal(caller?.userId, USER);
  });

  it('treats an absent credential as anonymous, not as an error', async () => {
    // Guest browsing is a product requirement (PRD AUTH-03). Throwing here
    // would make every unauthenticated catalogue request a 401.
    const provider = new DevelopmentIdentityProvider(TOKEN, USER);
    assert.equal(await provider.resolve({}), null);
  });

  it('rejects a wrong token rather than falling back to anonymous', async () => {
    const provider = new DevelopmentIdentityProvider(TOKEN, USER);
    await assert.rejects(() => provider.resolve({ authorization: 'Bearer wrong' }));
  });

  it('is case-insensitive about the Bearer prefix but not the token', async () => {
    const provider = new DevelopmentIdentityProvider(TOKEN, USER);
    assert.ok(await provider.resolve({ authorization: `bearer ${TOKEN}` }));
    await assert.rejects(() =>
      provider.resolve({ authorization: `Bearer ${TOKEN.toUpperCase()}` }),
    );
  });

  it('refuses to be constructed without a token', () => {
    assert.throws(() => new DevelopmentIdentityProvider('', USER));
  });

  it('refuses to be constructed without a user id', () => {
    assert.throws(() => new DevelopmentIdentityProvider(TOKEN, ''));
  });

  it('names itself unmistakably', () => {
    // The name appears in the startup log and the mobile sync panel. It has
    // to be obvious that no credential is being verified.
    const provider = new DevelopmentIdentityProvider(TOKEN, USER);
    assert.match(provider.name, /development/i);
    assert.match(provider.name, /no real authentication/i);
  });
});

describe('NullIdentityProvider', () => {
  it('resolves nobody, so every protected route fails closed', async () => {
    const provider = new NullIdentityProvider();
    assert.equal(await provider.resolve(), null);
  });
});

/**
 * Runs a snippet in a child process with production-ish environment.
 *
 * A child rather than the current process because `config/env.ts` derives
 * `isProduction` at module load, and this process loaded it as `test`. The
 * resolver hook is passed along because the backend's imports carry `.js`
 * extensions that only exist as `.ts` on disk.
 */
async function runInChild(
  script: string,
  env: Record<string, string>,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const backendRoot = path.resolve(import.meta.dirname, '..');
  const resolver = pathToFileURL(
    path.resolve(backendRoot, '..', '..', 'tools', 'node-ts-resolver.mjs'),
  ).href;

  try {
    const stdout = execFileSync(
      process.execPath,
      [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        '--import',
        resolver,
        '--input-type=module',
        '-e',
        script,
      ],
      {
        cwd: backendRoot,
        env: { ...process.env, LOG_LEVEL: 'silent', ...env },
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error: unknown) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('production refusal', () => {
  /**
   * The provider's constructor checks `isProduction`, which `config/env.ts`
   * derives from `NODE_ENV` at module load. The module is already loaded by
   * the time a test runs, so flipping `process.env.NODE_ENV` here would not
   * change it — the check is verified by re-importing the module graph with
   * production set, in a child process.
   *
   * Run as a subprocess rather than skipped, because "the production guard
   * works" is exactly the claim that must not be taken on trust.
   */
  it('throws when constructed with NODE_ENV=production', async () => {
    const { stdout } = await runInChild(
      `
      import { DevelopmentIdentityProvider } from './src/services/identity.js';
      try {
        new DevelopmentIdentityProvider('token', 'user');
        console.log('CONSTRUCTED');
      } catch {
        console.log('REFUSED');
      }
      `,
      { NODE_ENV: 'production', DEV_AUTH_ENABLED: 'false' },
    );

    assert.match(stdout, /REFUSED/, 'the provider must refuse to exist in production');
    assert.equal(stdout.includes('CONSTRUCTED'), false);
  });

  it('refuses to start the process when DEV_AUTH_ENABLED is true in production', async () => {
    const { status, stderr, stdout } = await runInChild(
      `import './src/config/env.js'; console.log('BOOTED');`,
      { NODE_ENV: 'production', DEV_AUTH_ENABLED: 'true', DEV_AUTH_TOKEN: 'anything' },
    );

    assert.notEqual(status, 0, 'the process must not start');
    assert.equal(stdout.includes('BOOTED'), false);
    assert.match(stderr, /Refusing to start/i);
  });

  /**
   * M2.5 CHANGED THE DEFAULT, AND THIS IS THE TEST THAT PINS IT.
   *
   * Before M2.5, a process with no development identity fell back to
   * `NullIdentityProvider` — resolve nobody, 401 everywhere. That was correct
   * when nothing could authenticate. It is now exactly wrong: a production
   * process that quietly resolved nobody would serve a catalogue where every
   * library endpoint returns empty, which reads as a data bug rather than as
   * an auth failure (ADR-27's own warning, applied to its successor).
   *
   * Production must get the real session provider. Not a null one, not a
   * development one.
   */
  it('registers the session provider in production, not a null one', async () => {
    const { stdout, status } = await runInChild(
      `
      import { registerIdentityProvider } from './src/bootstrap/identity.js';
      import { getIdentityProvider } from './src/services/identity.js';
      registerIdentityProvider();
      console.log('PROVIDER:' + getIdentityProvider().name);
      `,
      { NODE_ENV: 'production', DEV_AUTH_ENABLED: 'false' },
    );

    assert.equal(status, 0, 'the process must start');
    assert.match(stdout, /PROVIDER:session/, 'real session verification, in production');
    assert.doesNotMatch(stdout, /development/i, 'and no development fallback');
    assert.doesNotMatch(
      stdout,
      /authentication not implemented/i,
      'the null provider must never be what production falls back to',
    );
  });

  /**
   * In development both are registered, session first. The fallback is what
   * lets the existing tooling and the M2.3 development token keep working
   * while the app migrates, and the ORDER is the safety property: a valid
   * session token must authenticate as itself and never be downgraded into
   * the seeded development user.
   */
  it('chains session before the development fallback in development', async () => {
    const { stdout, status } = await runInChild(
      `
      import { registerIdentityProvider } from './src/bootstrap/identity.js';
      import { getIdentityProvider } from './src/services/identity.js';
      registerIdentityProvider();
      console.log('PROVIDER:' + getIdentityProvider().name);
      `,
      { NODE_ENV: 'development', DEV_AUTH_ENABLED: 'true', DEV_AUTH_TOKEN: 'local-dev-token' },
    );

    assert.equal(status, 0);
    assert.match(stdout, /PROVIDER:session, then development fallback/);
  });

  /**
   * A development token presented to a production process is just a wrong
   * credential. It must be refused by the session provider like any other
   * malformed token — never resolved.
   */
  it('refuses a development token in production', async () => {
    const { stdout, status } = await runInChild(
      `
      import { registerIdentityProvider } from './src/bootstrap/identity.js';
      import { getIdentityProvider } from './src/services/identity.js';
      registerIdentityProvider();
      try {
        const caller = await getIdentityProvider().resolve({
          authorization: 'Bearer local-dev-token',
        });
        console.log(caller ? 'RESOLVED:' + caller.userId : 'ANONYMOUS');
      } catch {
        console.log('REFUSED');
      }
      `,
      { NODE_ENV: 'production', DEV_AUTH_ENABLED: 'false', DEV_AUTH_TOKEN: 'local-dev-token' },
    );

    assert.equal(status, 0);
    assert.match(stdout, /REFUSED/);
    assert.doesNotMatch(stdout, /RESOLVED/, 'a development token must grant nothing');
  });

  it('starts normally in production when the development identity is off', async () => {
    // The guard must refuse the dangerous combination and nothing else.
    const { status, stdout } = await runInChild(
      `import './src/config/env.js'; console.log('BOOTED');`,
      { NODE_ENV: 'production', DEV_AUTH_ENABLED: 'false' },
    );

    assert.equal(status, 0);
    assert.match(stdout, /BOOTED/);
  });
});
