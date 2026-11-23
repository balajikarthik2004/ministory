import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthSession, CurrentUser, RegisterResponse } from '@minidrama/contracts';
import { apiRequest, dataOf, prisma, resetTestData, stopTestServer } from './support/harness.js';
import { seedReferenceData } from './support/factories.js';

/**
 * Authentication — M2.5 Phase 6.
 *
 * EVERYTHING HERE GOES THROUGH HTTP. A test that reaches into the service
 * layer proves the service works; it does not prove the route is mounted, the
 * body is validated, the guard is applied or the error maps to the right
 * status. Those are the things that actually break, so the suite drives the
 * same surface a client does — with two exceptions, both explicit: the
 * database is read to assert what was *stored* (a hash, never a password),
 * and the mail provider is swapped for an in-memory one so a token that was
 * emailed can be used, which is the only way to test reset end to end without
 * testing something other than what a user does.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY `src/` IS IMPORTED DYNAMICALLY BELOW AND NOT AT THE TOP OF THE FILE.
 *
 * `support/harness.ts` pins `DATABASE_URL` to the test database behind a
 * TOP-LEVEL AWAIT. Under ESM, a sibling static import is evaluated while that
 * await is still pending — so `import ... from '../src/services/mail.js'` at
 * the top of this file would pull in `config/env.ts`, which reads
 * `process.env` at module load, BEFORE the harness had repointed it. The
 * suite would then connect to the developer's database.
 *
 * The harness's post-connection `SELECT current_database()` guard (ADR-30)
 * catches it and refuses to run, which is precisely what that guard was added
 * for. Importing after the harness has resolved is the fix, and it is the
 * same discipline `support/harness.ts` applies to the application itself.
 * ────────────────────────────────────────────────────────────────────────
 */

const { MemoryMailProvider, setMailProvider } = await import('../src/services/mail.js');
const { needsRehash } = await import('../src/services/password.js');

const mail = new MemoryMailProvider();

/** Extracts the token from the link in whatever was last sent to `email`. */
function tokenFor(email: string, subjectFragment: string): string {
  const message = [...mail.sent]
    .reverse()
    .find((m) => m.to === email && m.subject.includes(subjectFragment));
  assert.ok(message, `no message to ${email} matching "${subjectFragment}"`);
  const match = /token=([A-Za-z0-9_-]+)/.exec(message.body);
  assert.ok(match?.[1], 'the message carried no token');
  return match[1];
}

const PASSWORD = 'a-perfectly-fine-password';

async function register(email: string, password = PASSWORD): Promise<RegisterResponse> {
  return dataOf(
    await apiRequest<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: { email, password },
    }),
  );
}

async function login(email: string, password = PASSWORD): Promise<AuthSession> {
  return dataOf(
    await apiRequest<AuthSession>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  );
}

/** A registered, signed-in account. The common starting point. */
async function signedInUser(email: string): Promise<AuthSession> {
  await register(email);
  return login(email);
}

before(async () => {
  setMailProvider(mail);
  await resetTestData();
  await seedReferenceData();
});

beforeEach(async () => {
  await prisma.session.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.user.deleteMany();
  mail.clear();
});

after(async () => {
  await stopTestServer();
});

// ─────────────────────────────── Registration ───────────────────────────────

describe('registration', () => {
  it('creates an account and sends a confirmation email', async () => {
    const response = await register('new@example.com');
    assert.equal(response.accepted, true);

    const user = await prisma.user.findUnique({ where: { email: 'new@example.com' } });
    assert.ok(user, 'the account should exist');
    assert.equal(user.isAnonymous, false);
    assert.equal(user.emailVerifiedAt, null, 'a new address is unverified');

    const sent = mail.lastTo('new@example.com');
    assert.match(sent?.subject ?? '', /Confirm your MiniDrama email/);
  });

  it('never stores the password, only an argon2id hash', async () => {
    await register('hashed@example.com');
    const user = await prisma.user.findUnique({ where: { email: 'hashed@example.com' } });

    assert.ok(user?.passwordHash);
    assert.notEqual(user.passwordHash, PASSWORD);
    assert.ok(
      !user.passwordHash.includes(PASSWORD),
      'the plaintext must not appear anywhere in the stored value',
    );
    assert.match(user.passwordHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.equal(needsRehash(user.passwordHash), false, 'written at current parameters');
  });

  /**
   * THE ENUMERATION TEST. A duplicate registration must be indistinguishable
   * from a successful one: same status, same body. If this ever fails,
   * somebody has made registration friendlier and turned it into a way to
   * test whether an address has an account.
   */
  it('answers a duplicate email identically, and creates nothing', async () => {
    const first = await apiRequest<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: { email: 'taken@example.com', password: PASSWORD },
    });
    mail.clear();

    const second = await apiRequest<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: { email: 'taken@example.com', password: 'a-completely-different-one' },
    });

    assert.equal(second.status, first.status);
    assert.deepEqual(second.body, first.body, 'byte-identical, request id aside');

    const count = await prisma.user.count({ where: { email: 'taken@example.com' } });
    assert.equal(count, 1, 'no second account');

    // The real owner is told, which is what makes the silence above honest.
    const notice = mail.lastTo('taken@example.com');
    assert.match(notice?.subject ?? '', /Someone tried to sign up/);

    // And the original password still works — the duplicate attempt must not
    // have overwritten anything.
    const session = await login('taken@example.com');
    assert.ok(session.accessToken);
  });

  it('rejects a password under twelve characters', async () => {
    const response = await apiRequest('/auth/register', {
      method: 'POST',
      body: { email: 'short@example.com', password: 'tooshort' },
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.success === false ? response.body.error.code : null,
      'VALIDATION_ERROR',
    );
  });

  it('normalises the email, so case cannot create a second account', async () => {
    await register('Mixed.Case@Example.COM');
    const user = await prisma.user.findUnique({ where: { email: 'mixed.case@example.com' } });
    assert.ok(user, 'stored lowercased');

    // Signing in with different casing reaches the same account.
    const session = await login('MIXED.CASE@example.com');
    assert.equal(session.user.id, user.id);
  });
});

// ───────────────────────────────── Login ─────────────────────────────────

describe('login', () => {
  it('issues an access token and a refresh token', async () => {
    const session = await signedInUser('signin@example.com');

    assert.ok(session.accessToken.length > 0);
    assert.ok(session.refreshToken.length > 0);
    assert.equal(session.expiresIn, 900);
    assert.equal(session.user.email, 'signin@example.com');
    assert.equal(session.emailVerified, false);
  });

  it('stores only a hash of the refresh token', async () => {
    const session = await signedInUser('hash@example.com');
    const rows = await prisma.session.findMany();

    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]?.refreshHash, session.refreshToken);
    assert.match(rows[0]?.refreshHash ?? '', /^[0-9a-f]{64}$/, 'sha-256 hex');
  });

  /**
   * A wrong password and an unknown account must be the same 401 with the
   * same sentence. Asserting the messages are EQUAL rather than just both
   * present is the point — a friendlier message for one of them is the usual
   * way this protection is lost.
   */
  it('cannot distinguish a wrong password from a missing account', async () => {
    await register('real@example.com');

    const wrongPassword = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'real@example.com', password: 'not-the-right-password' },
    });
    const noAccount = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'absent@example.com', password: PASSWORD },
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(noAccount.status, 401);
    /*
     * Compared field by field rather than as whole objects: the error
     * envelope carries a per-request `requestId` that is SUPPOSED to differ.
     * The code and the sentence are what must not — a friendlier message for
     * one of these two cases is how this protection is usually lost.
     */
    const wrongError = wrongPassword.body.success === false ? wrongPassword.body.error : null;
    const missingError = noAccount.body.success === false ? noAccount.body.error : null;

    assert.ok(wrongError && missingError);
    assert.equal(missingError.code, wrongError.code);
    assert.equal(missingError.message, wrongError.message);
  });

  it('refuses a suspended account with the same message', async () => {
    await register('suspended@example.com');
    await prisma.user.update({
      where: { email: 'suspended@example.com' },
      data: { status: 'SUSPENDED' },
    });

    const response = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'suspended@example.com', password: PASSWORD },
    });

    assert.equal(response.status, 401);
    assert.match(
      response.body.success === false ? response.body.error.message : '',
      /do not match an account/,
      'account status must not be observable',
    );
  });
});

// ──────────────────────────── Access tokens ────────────────────────────

describe('access tokens', () => {
  it('authenticates a protected route', async () => {
    const session = await signedInUser('me@example.com');
    const me = dataOf(await apiRequest<CurrentUser>('/auth/me', { token: session.accessToken }));

    assert.equal(me.user.email, 'me@example.com');
    assert.equal(me.isGuest, false);
    assert.equal(me.emailVerified, false);
  });

  it('refuses a request with no credential', async () => {
    const response = await apiRequest('/me/favorites');
    assert.equal(response.status, 401);
  });

  it('refuses a malformed token', async () => {
    const response = await apiRequest('/auth/me', { token: 'not-a-jwt-at-all' });
    assert.equal(response.status, 401);
  });

  /**
   * A token signed with the right key but the wrong audience must fail.
   *
   * This is the check that will keep an M5 admin token from authenticating a
   * consumer route (ARCH §6). It is worth a test now precisely because
   * nothing yet issues a second audience — the guard is invisible until it is
   * needed, and an invisible guard is one a refactor removes.
   */
  it('refuses a token minted for a different audience', async () => {
    const { SignJWT } = await import('jose');
    const { env } = await import('../src/config/env.js');
    const key = new TextEncoder().encode(env.AUTH_JWT_SECRET);

    const foreign = await new SignJWT({ typ: 'access', sid: 'whatever', anon: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user_anything')
      .setIssuer(env.AUTH_TOKEN_ISSUER)
      .setAudience('minidrama-admin')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);

    const response = await apiRequest('/auth/me', { token: foreign });
    assert.equal(response.status, 401);
  });

  it('refuses an expired token', async () => {
    const { SignJWT } = await import('jose');
    const { env } = await import('../src/config/env.js');
    const key = new TextEncoder().encode(env.AUTH_JWT_SECRET);

    const session = await signedInUser('expired@example.com');
    const user = await prisma.user.findUnique({ where: { email: 'expired@example.com' } });
    const row = await prisma.session.findFirst({ where: { userId: user?.id } });

    const stale = await new SignJWT({ typ: 'access', sid: row?.id ?? '', anon: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user?.id ?? '')
      .setIssuer(env.AUTH_TOKEN_ISSUER)
      .setAudience(env.AUTH_TOKEN_AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(key);

    const response = await apiRequest('/auth/me', { token: stale });
    assert.equal(response.status, 401);
    assert.equal(
      response.body.success === false ? response.body.error.code : null,
      'TOKEN_EXPIRED',
      'the client branches on this: expired means refresh, not sign in again',
    );

    // The live token still works, so this was about the token and not the session.
    assert.equal((await apiRequest('/auth/me', { token: session.accessToken })).status, 200);
  });

  it('stops accepting a token issued before a revocation point', async () => {
    const session = await signedInUser('revoked@example.com');
    assert.equal((await apiRequest('/auth/me', { token: session.accessToken })).status, 200);

    // What a password change does, without changing the password.
    await prisma.user.update({
      where: { email: 'revoked@example.com' },
      data: { tokensValidFrom: new Date(Date.now() + 1000) },
    });

    const response = await apiRequest('/auth/me', { token: session.accessToken });
    assert.equal(response.status, 401, 'revocation must not wait for expiry');
  });
});

// ─────────────────────────── Refresh and rotation ───────────────────────────

describe('refresh tokens', () => {
  it('rotates on every use', async () => {
    const session = await signedInUser('rotate@example.com');

    const rotated = dataOf(
      await apiRequest<AuthSession>('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: session.refreshToken },
      }),
    );

    assert.notEqual(rotated.refreshToken, session.refreshToken, 'a new token every time');
    assert.ok(rotated.accessToken);

    // The new one works.
    assert.equal(
      (
        await apiRequest('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: rotated.refreshToken },
        })
      ).status,
      200,
    );
  });

  /**
   * THE REUSE TEST, and the most important one in this file.
   *
   * Presenting an already-rotated token means two parties hold tokens from
   * one chain. We cannot tell which is the thief, so the entire family is
   * revoked and both sign in again. Without this, a stolen refresh token
   * works forever: every use mints the attacker a fresh one.
   */
  it('revokes the whole family when a rotated token is replayed', async () => {
    const session = await signedInUser('reuse@example.com');

    const second = dataOf(
      await apiRequest<AuthSession>('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: session.refreshToken },
      }),
    );
    const third = dataOf(
      await apiRequest<AuthSession>('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: second.refreshToken },
      }),
    );

    // Replay the first, long-rotated token.
    const replay = await apiRequest('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: session.refreshToken },
    });
    assert.equal(replay.status, 401);

    // The CURRENT token is now dead too — that is the family revocation.
    const afterReuse = await apiRequest('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: third.refreshToken },
    });
    assert.equal(afterReuse.status, 401, 'the legitimate holder is signed out as well');

    const rows = await prisma.session.findMany();
    assert.ok(rows.length >= 3);
    assert.ok(
      rows.every((row) => row.revokedAt !== null),
      'every session in the chain is revoked',
    );
    assert.ok(
      rows.some((row) => row.revokedReason === 'REFRESH_REUSE'),
      'and the reason is recorded, so a replay is distinguishable from a logout',
    );
  });

  it('refuses an unknown refresh token', async () => {
    const response = await apiRequest('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: 'nothing-like-a-real-token' },
    });
    assert.equal(response.status, 401);
  });

  it('refuses an expired refresh token', async () => {
    const session = await signedInUser('stale@example.com');
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await apiRequest('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: session.refreshToken },
    });
    assert.equal(response.status, 401);
  });
});

// ──────────────────────────── Logout and revocation ────────────────────────────

describe('logout', () => {
  it('revokes the presented session and leaves others alone', async () => {
    const first = await signedInUser('two-devices@example.com');
    const second = await login('two-devices@example.com');

    const response = await apiRequest('/auth/logout', {
      method: 'POST',
      token: first.accessToken,
      body: { refreshToken: first.refreshToken },
    });
    assert.equal(response.status, 200);

    assert.equal(
      (
        await apiRequest('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: first.refreshToken },
        })
      ).status,
      401,
      'this device is signed out',
    );
    assert.equal(
      (
        await apiRequest('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: second.refreshToken },
        })
      ).status,
      200,
      'the other device is not',
    );
  });

  it('signs out every device when asked', async () => {
    const first = await signedInUser('all-devices@example.com');
    const second = await login('all-devices@example.com');

    await apiRequest('/auth/logout', {
      method: 'POST',
      token: first.accessToken,
      body: { allDevices: true },
    });

    for (const token of [first.refreshToken, second.refreshToken]) {
      assert.equal(
        (await apiRequest('/auth/refresh', { method: 'POST', body: { refreshToken: token } }))
          .status,
        401,
      );
    }
  });

  /**
   * Logging out with somebody else's refresh token must do nothing.
   *
   * Otherwise logout is a way to sign other people out using a token you had
   * stolen but could not otherwise use.
   */
  it('ignores a refresh token belonging to another account', async () => {
    const mine = await signedInUser('mine@example.com');
    const theirs = await signedInUser('theirs@example.com');

    const response = await apiRequest('/auth/logout', {
      method: 'POST',
      token: mine.accessToken,
      body: { refreshToken: theirs.refreshToken },
    });
    assert.equal(response.status, 200, 'logout never fails');

    assert.equal(
      (
        await apiRequest('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: theirs.refreshToken },
        })
      ).status,
      200,
      "the other account's session is untouched",
    );
  });

  it('requires authentication', async () => {
    assert.equal((await apiRequest('/auth/logout', { method: 'POST', body: {} })).status, 401);
  });
});

// ──────────────────────────── Password change ────────────────────────────

describe('password change', () => {
  it('changes the password and signs every device out', async () => {
    const session = await signedInUser('change@example.com');
    const other = await login('change@example.com');

    const response = await apiRequest('/auth/change-password', {
      method: 'POST',
      token: session.accessToken,
      body: { currentPassword: PASSWORD, newPassword: 'an-entirely-new-password' },
    });
    assert.equal(response.status, 200);

    assert.equal(
      (await apiRequest('/auth/me', { token: session.accessToken })).status,
      401,
      'this session ends immediately, not in fifteen minutes',
    );
    assert.equal(
      (
        await apiRequest('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: other.refreshToken },
        })
      ).status,
      401,
      'and so does every other device',
    );

    const fresh = await login('change@example.com', 'an-entirely-new-password');
    assert.ok(fresh.accessToken);
  });

  it('refuses a wrong current password and changes nothing', async () => {
    const session = await signedInUser('wrong-current@example.com');

    const response = await apiRequest('/auth/change-password', {
      method: 'POST',
      token: session.accessToken,
      body: { currentPassword: 'not-my-password', newPassword: 'a-brand-new-password' },
    });
    assert.equal(response.status, 401);

    const unchanged = await login('wrong-current@example.com');
    assert.ok(unchanged.accessToken, 'the original password still works');
  });
});

// ──────────────────────────── Password reset ────────────────────────────

describe('password reset', () => {
  it('resets the password from an emailed token', async () => {
    await register('reset@example.com');
    const session = await login('reset@example.com');

    const request = await apiRequest('/auth/forgot-password', {
      method: 'POST',
      body: { email: 'reset@example.com' },
    });
    assert.equal(request.status, 200);

    const token = tokenFor('reset@example.com', 'Reset your MiniDrama password');
    const reset = await apiRequest('/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'the-new-password-here' },
    });
    assert.equal(reset.status, 200);

    assert.ok((await login('reset@example.com', 'the-new-password-here')).accessToken);

    const oldPassword = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'reset@example.com', password: PASSWORD },
    });
    assert.equal(oldPassword.status, 401, 'the old password is dead');

    assert.equal(
      (await apiRequest('/auth/me', { token: session.accessToken })).status,
      401,
      'a reset signs out the sessions a thief may be holding',
    );
  });

  it('refuses a reused reset token', async () => {
    await register('once@example.com');
    await apiRequest('/auth/forgot-password', {
      method: 'POST',
      body: { email: 'once@example.com' },
    });
    const token = tokenFor('once@example.com', 'Reset your MiniDrama password');

    const first = await apiRequest('/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'first-new-password' },
    });
    assert.equal(first.status, 200);

    const second = await apiRequest('/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'second-new-password' },
    });
    assert.equal(second.status, 400, 'single use');

    assert.ok(
      (await login('once@example.com', 'first-new-password')).accessToken,
      'the second attempt changed nothing',
    );
  });

  it('refuses an expired reset token', async () => {
    await register('expired-reset@example.com');
    await apiRequest('/auth/forgot-password', {
      method: 'POST',
      body: { email: 'expired-reset@example.com' },
    });
    const token = tokenFor('expired-reset@example.com', 'Reset your MiniDrama password');

    await prisma.verificationToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await apiRequest('/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'too-late-for-this' },
    });
    assert.equal(response.status, 400);
  });

  it('invalidates an earlier link when a new one is requested', async () => {
    await register('two-links@example.com');

    await apiRequest('/auth/forgot-password', {
      method: 'POST',
      body: { email: 'two-links@example.com' },
    });
    const firstToken = tokenFor('two-links@example.com', 'Reset your MiniDrama password');

    await apiRequest('/auth/forgot-password', {
      method: 'POST',
      body: { email: 'two-links@example.com' },
    });
    const secondToken = tokenFor('two-links@example.com', 'Reset your MiniDrama password');
    assert.notEqual(firstToken, secondToken);

    assert.equal(
      (
        await apiRequest('/auth/reset-password', {
          method: 'POST',
          body: { token: firstToken, newPassword: 'from-the-old-link' },
        })
      ).status,
      400,
      'the superseded link is dead',
    );
    assert.equal(
      (
        await apiRequest('/auth/reset-password', {
          method: 'POST',
          body: { token: secondToken, newPassword: 'from-the-new-link' },
        })
      ).status,
      200,
    );
  });

  /** Unknown addresses must be answered identically, and send nothing. */
  it('answers an unknown address the same way and emails nobody', async () => {
    await register('known@example.com');
    mail.clear();

    const known = await apiRequest('/auth/forgot-password', {
      method: 'POST',
      body: { email: 'known@example.com' },
    });
    const unknown = await apiRequest('/auth/forgot-password', {
      method: 'POST',
      body: { email: 'nobody@example.com' },
    });

    assert.equal(unknown.status, known.status);
    assert.deepEqual(unknown.body, known.body);

    assert.equal(
      mail.sent.filter((m) => m.to === 'nobody@example.com').length,
      0,
      'nothing is sent to an address with no account',
    );
  });
});

// ──────────────────────────── Email verification ────────────────────────────

describe('email verification', () => {
  it('verifies from the emailed token, once', async () => {
    await register('verify@example.com');
    const token = tokenFor('verify@example.com', 'Confirm your MiniDrama email');

    const first = await apiRequest('/auth/verify-email', { method: 'POST', body: { token } });
    assert.equal(first.status, 200);

    const user = await prisma.user.findUnique({ where: { email: 'verify@example.com' } });
    assert.ok(user?.emailVerifiedAt, 'recorded on the account');

    const replay = await apiRequest('/auth/verify-email', { method: 'POST', body: { token } });
    assert.equal(replay.status, 400, 'single use');
  });

  it('reports the verified state on the session and on /auth/me', async () => {
    await register('verified-state@example.com');
    const token = tokenFor('verified-state@example.com', 'Confirm your MiniDrama email');
    await apiRequest('/auth/verify-email', { method: 'POST', body: { token } });

    const session = await login('verified-state@example.com');
    assert.equal(session.emailVerified, true);

    const me = dataOf(await apiRequest<CurrentUser>('/auth/me', { token: session.accessToken }));
    assert.equal(me.emailVerified, true);
  });

  it('refuses a token that does not exist', async () => {
    const response = await apiRequest('/auth/verify-email', {
      method: 'POST',
      body: { token: 'completely-made-up-token' },
    });
    assert.equal(response.status, 400);
  });

  /**
   * A completed reset proves control of the mailbox, so it verifies the
   * address. Asking for a second link to prove what was just proved is
   * ceremony, not security.
   */
  it('treats a completed password reset as proof of the address', async () => {
    await register('reset-verifies@example.com');
    await apiRequest('/auth/forgot-password', {
      method: 'POST',
      body: { email: 'reset-verifies@example.com' },
    });
    const token = tokenFor('reset-verifies@example.com', 'Reset your MiniDrama password');

    await apiRequest('/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword: 'a-replacement-password' },
    });

    const session = await login('reset-verifies@example.com', 'a-replacement-password');
    assert.equal(session.emailVerified, true);
  });
});

// ──────────────────────────────── Rate limiting ────────────────────────────────

describe('rate limiting', () => {
  /**
   * The login limiter is keyed on source AND email, so this exhausts the
   * allowance for ONE address. `AUTH_LOGIN_RATE_MAX` is 10 per window.
   */
  it('throttles repeated failed logins against one address', async () => {
    await register('bruteforce@example.com');

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await apiRequest('/auth/login', {
        method: 'POST',
        body: { email: 'bruteforce@example.com', password: `guess-number-${attempt}` },
      });
      statuses.push(response.status);
    }

    assert.ok(statuses.includes(429), 'guessing must become impossible, not merely slow');
    assert.equal(statuses[0], 401, 'the first attempts answer normally');
  });

  /**
   * And the limit must be per-address, or one person failing to sign in would
   * lock out everyone else behind the same mobile NAT — which is most of the
   * launch audience (API_DOCUMENTATION.md §9).
   */
  it('does not throttle a different address from the same source', async () => {
    await register('noisy@example.com');
    await register('quiet@example.com');

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await apiRequest('/auth/login', {
        method: 'POST',
        body: { email: 'noisy@example.com', password: `wrong-${attempt}` },
      });
    }

    const other = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'quiet@example.com', password: PASSWORD },
    });
    assert.equal(other.status, 200, 'a neighbour on the same IP is unaffected');
  });
});
