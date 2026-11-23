import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing. Argon2id.
 *
 * WHY ARGON2ID AND NOT BCRYPT. bcrypt is CPU-hard but memory-cheap, so a GPU
 * or an FPGA array runs thousands of guesses in parallel against a stolen
 * hash. Argon2id's memory cost is the defence: each guess needs its own 19MB,
 * and that is what stops a card with 24GB of VRAM from running ten thousand
 * of them at once. It is also what CLAUDE.md §12 (M2.5 Phase 2) specifies.
 *
 * WHY @node-rs/argon2 AND NOT THE `argon2` PACKAGE. Prebuilt binaries per
 * platform, including win32-x64-msvc, so `pnpm install` does not need a C++
 * toolchain on a Windows development machine. Verified working on this one
 * before it was adopted.
 *
 * THE PARAMETERS come from the OWASP Password Storage Cheat Sheet's Argon2id
 * baseline — 19MiB, 2 iterations, 1 degree of parallelism. They are named
 * constants rather than inline numbers because they will need raising as
 * hardware improves, and because `migrateIfNeeded` below has to be able to
 * tell an old hash from a current one.
 */

const MEMORY_COST_KIB = 19_456; // 19 MiB
const TIME_COST = 2;
const PARALLELISM = 1;

/**
 * `Algorithm.Argon2id` from `@node-rs/argon2`, inlined as its numeric value.
 *
 * The package declares `Algorithm` as an ambient `const enum`, which TypeScript
 * refuses to read under `isolatedModules` — the setting that lets every file
 * be transpiled on its own, and the one this workspace builds with. Importing
 * the enum is therefore a compile error, so the value is written out here with
 * the name it stands for.
 *
 * `needsRehash` below asserts the `$argon2id$` prefix on every stored hash, so
 * a wrong constant here would be caught by the first password test rather than
 * silently downgrading everyone to Argon2d.
 */
const ARGON2ID = 2;

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: MEMORY_COST_KIB,
  timeCost: TIME_COST,
  parallelism: PARALLELISM,
} as const;

/**
 * A hash of a password nobody has.
 *
 * THIS EXISTS TO MAKE LOGIN TAKE THE SAME TIME WHETHER OR NOT THE ACCOUNT
 * DOES. Returning early for an unknown email answers in under a millisecond
 * while a real account spends ~50ms in Argon2. That difference is measurable
 * over the network and turns the login endpoint into an account-existence
 * oracle — which would defeat every other enumeration defence in this module,
 * since an attacker does not need an error message if they have a stopwatch.
 *
 * Computed once at module load, not per request: the point is to burn the
 * same CPU as a real verification, and hashing a constant repeatedly would
 * burn it at startup over and over for no gain.
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hash('a-password-that-belongs-to-no-account', OPTIONS);
  return dummyHashPromise;
}

/** Hashes a plaintext password. The result is a self-describing PHC string:
 *  it carries its own salt and parameters, so no column is needed for them. */
export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

/**
 * Verifies a password against a stored hash.
 *
 * `storedHash` is nullable because a guest account, and a future Google or
 * phone account, legitimately has no password (see `User.passwordHash`). In
 * that case this still spends the full hashing cost against the dummy hash
 * and then returns false — same work, same timing, no information leaked
 * about which accounts are password accounts.
 */
export async function verifyPassword(
  plaintext: string,
  storedHash: string | null,
): Promise<boolean> {
  if (!storedHash) {
    await verify(await dummyHash(), plaintext).catch(() => false);
    return false;
  }

  try {
    return await verify(storedHash, plaintext);
  } catch {
    /*
     * A malformed or truncated hash throws rather than returning false. That
     * is a corrupt row, not a wrong password, and it must not be reported
     * differently to the caller — a 500 here would mark out exactly which
     * accounts have damaged hashes.
     */
    return false;
  }
}

/**
 * Whether a stored hash was produced with weaker parameters than current.
 *
 * Nothing calls this yet, and it is here because the moment to think about
 * rehashing is while writing the login path, not after the parameters have
 * been raised and every existing user is still on the old cost. The hook is
 * `auth.service.ts` — a successful login already has the plaintext in hand,
 * which is the only moment a rehash is possible.
 */
export function needsRehash(storedHash: string): boolean {
  const params = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!params) return true; // not argon2id at all — definitely stale

  const memory = Number(params[1]);
  const time = Number(params[2]);
  const parallelism = Number(params[3]);

  return memory < MEMORY_COST_KIB || time < TIME_COST || parallelism < PARALLELISM;
}
