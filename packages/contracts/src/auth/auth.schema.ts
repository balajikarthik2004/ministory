import { z } from 'zod';
import { userProfileSchema } from '../library/library.schema.js';

/**
 * Authentication contract — M2.5. API_DOCUMENTATION.md §2.
 *
 * TWO RULES SHAPE EVERYTHING HERE.
 *
 * 1. NO REQUEST CARRIES A USER ID. Not one schema in this file has a `userId`
 *    field, and that is deliberate rather than incidental. The caller is
 *    whoever their credential says they are, resolved by middleware; a
 *    body-supplied id would be an ownership claim the server has to disprove
 *    (CLAUDE.md §11, and the same rule the library contract already follows).
 *
 * 2. NO RESPONSE DISTINGUISHES "WRONG PASSWORD" FROM "NO SUCH ACCOUNT", and
 *    none confirms whether an address is registered. Registration, login and
 *    password-reset responses are shaped so that an attacker holding a list of
 *    email addresses learns nothing about which ones exist. Where that costs
 *    us a nicer error message, the message loses.
 */

// ───────────────────────────── Primitives ─────────────────────────────

/**
 * Email, normalised on the way in.
 *
 * Lowercased and trimmed in the schema rather than in a service, so that every
 * consumer — backend, mobile, a future admin app — normalises identically. If
 * one of them skipped it, `Priya@example.com` and `priya@example.com` would
 * become two accounts, and the unique constraint would not stop it.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter a valid email address.');

/**
 * Password policy: length only.
 *
 * TWELVE CHARACTERS, NO COMPOSITION RULES. Mandatory symbols and digits push
 * people towards `Password1!` — a short, predictable string that satisfies
 * every rule and appears in the first thousand entries of any cracking
 * dictionary. Length is the property that actually resists an offline attack
 * on a stolen hash, and it is the only one worth enforcing. This follows
 * current NIST 800-63B guidance rather than the habit it replaced.
 *
 * The 128-character ceiling is a denial-of-service bound, not a security one:
 * Argon2id hashes whatever it is given, and a megabyte password would mean a
 * megabyte of hashing per login attempt.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'That password is too long.');

/**
 * A device identifier, generated and stored by the client.
 *
 * Opaque to the server and NOT a security credential — it identifies an
 * install so a guest account survives an app restart, and nothing more. No
 * endpoint grants access on the strength of a device id alone.
 */
export const deviceIdSchema = z.string().trim().min(8).max(128);

export const platformSchema = z.enum(['android', 'ios', 'web']);

// ───────────────────────────── Session ─────────────────────────────

/**
 * What a successful authentication returns.
 *
 * The refresh token is the only time the raw value is ever transmitted; the
 * server keeps a hash and cannot reproduce it (see `Session.refreshHash`).
 */
export const authSessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Access-token lifetime in seconds, so the client can refresh proactively. */
  expiresIn: z.number().int().positive(),
  user: userProfileSchema,
  /**
   * Whether the address has been confirmed.
   *
   * CARRIED ON THE SESSION, not left for the client to fetch from
   * `/auth/me`. Without it a client that has just signed in does not know,
   * and the only safe assumption is "unverified" — which means showing the
   * confirm-your-email prompt to people who already have. A boolean on a
   * response the client already parses costs nothing and removes a round
   * trip from the one screen that needs the answer.
   *
   * DISPLAY ONLY. Nothing is authorised from it; the server re-reads
   * `User.emailVerifiedAt` wherever verification actually matters.
   */
  emailVerified: z.boolean(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

const deviceContextSchema = z.object({
  deviceId: deviceIdSchema.optional(),
  platform: platformSchema.optional(),
});

// ───────────────────────────── Requests ─────────────────────────────

export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(60).optional(),
  })
  .extend(deviceContextSchema.shape);
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * Registration's response.
 *
 * NOT a session. An account is created and the caller is told to check their
 * email — the identical response they get when the address was already taken,
 * in which case nothing is created and the existing owner receives a notice
 * instead. Returning a session on success would make the two cases trivially
 * distinguishable and turn registration into an account-existence oracle.
 *
 * The cost is one extra screen: register, then sign in. That is the right
 * trade, and it is also how the user discovers their password works.
 */
export const registerResponseSchema = z.object({
  /** Always true. Present so the client has something to branch on later. */
  accepted: z.literal(true),
  message: z.string(),
});
export type RegisterResponse = z.infer<typeof registerResponseSchema>;

export const loginRequestSchema = z
  .object({
    email: emailSchema,
    /**
     * Deliberately NOT `passwordSchema`. Validating a login password against
     * the registration policy would reject a short password with a different
     * error than a wrong one — telling an attacker that the policy, and so
     * the account, is newer or older than some date. A login takes any
     * non-empty string and fails the same way regardless.
     */
    password: z.string().min(1).max(128),
  })
  .extend(deviceContextSchema.shape);
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Creates or resumes an anonymous account bound to this install (AUTH-03). */
export const guestRequestSchema = z.object({
  deviceId: deviceIdSchema,
  platform: platformSchema.optional(),
});
export type GuestRequest = z.infer<typeof guestRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1).optional(),
  /** Signs out every session for this user, not just this device. */
  allDevices: z.boolean().optional(),
});
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const forgotPasswordRequestSchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(1).max(256),
  newPassword: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const verifyEmailRequestSchema = z.object({
  token: z.string().min(1).max(256),
});
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

/**
 * Promotes the caller's guest account into a registered one (AUTH-06).
 *
 * The guest is identified by the ACCESS TOKEN on the request, never by a body
 * field. A `guestUserId` parameter would let anyone claim anyone's anonymous
 * account and inherit its history.
 */
export const mergeGuestRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(60).optional(),
  })
  .extend(deviceContextSchema.shape);
export type MergeGuestRequest = z.infer<typeof mergeGuestRequestSchema>;

// ───────────────────────────── Responses ─────────────────────────────

/**
 * The response to every endpoint that must not reveal whether an account
 * exists: forgot-password, and registration's duplicate path.
 *
 * One shape, one message, one status, whatever actually happened.
 */
export const acknowledgementSchema = z.object({
  accepted: z.literal(true),
  message: z.string(),
});
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

/** `GET /auth/me`. The profile the library module already defines, plus state
 *  that only the authentication layer knows. */
export const currentUserSchema = z.object({
  user: userProfileSchema,
  emailVerified: z.boolean(),
  /** True while the account is anonymous, so the UI can offer the upgrade. */
  isGuest: z.boolean(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

/** What `POST /auth/merge` carried across, so the client can report it
 *  honestly rather than claiming a merge that moved nothing. */
export const mergeResultSchema = z.object({
  session: authSessionSchema,
  moved: z.object({
    watchHistory: z.number().int().nonnegative(),
    dramaProgress: z.number().int().nonnegative(),
    favorites: z.number().int().nonnegative(),
    playbackEvents: z.number().int().nonnegative(),
  }),
});
export type MergeResult = z.infer<typeof mergeResultSchema>;

// ────────────────────────── Account deletion (M2.6) ──────────────────────────

/**
 * The word a viewer types, or the client sends, to confirm deletion.
 *
 * Exported so the mobile confirmation field and the server's check cannot
 * drift apart. It is a deliberate speed bump, not a security control — the
 * security control is the password (or, for a guest, the access token).
 */
export const DELETION_CONFIRMATION = 'DELETE' as const;

/**
 * `DELETE /auth/account`.
 *
 * NO `userId`, like everything else in this file — the account deleted is the
 * caller's, resolved from the access token. A body-supplied id would make
 * deletion a weapon rather than a right.
 *
 * `password` IS OPTIONAL BECAUSE GUESTS EXIST, not because it is optional for
 * accounts that have one. The server requires it whenever `User.passwordHash`
 * is set and refuses with 403 when it is missing — the schema cannot express
 * "required depending on a row the client cannot see" (PD/D2).
 */
export const deleteAccountRequestSchema = z.object({
  /**
   * Deliberately NOT `passwordSchema`, for the reason `loginRequestSchema`
   * gives: validating a re-authentication against the registration policy
   * would reject an old short password differently from a wrong one.
   */
  password: z.string().min(1).max(128).optional(),
  confirm: z.literal(DELETION_CONFIRMATION),
});
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

/** How much was removed. Counts only — never what was watched. */
export const deletionCountsSchema = z.object({
  watchHistory: z.number().int().nonnegative(),
  dramaProgress: z.number().int().nonnegative(),
  favorites: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  verificationTokens: z.number().int().nonnegative(),
});
export type DeletionCounts = z.infer<typeof deletionCountsSchema>;

export const deleteAccountResponseSchema = z.object({
  accepted: z.literal(true),
  deletedAt: z.string(),
  removed: deletionCountsSchema,
  /**
   * Whether the server stored a receipt for this deletion.
   *
   * True when the client sent an `Idempotency-Key`. It matters because the
   * receipt is the ONLY way to answer "did my deletion go through?" after the
   * fact — deletion destroys the credential that would otherwise ask. A client
   * that sees `false` here knows it has no recovery path and should say so
   * rather than assume one exists.
   */
  receiptRecorded: z.boolean(),
  message: z.string(),
});
export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;

/**
 * `POST /auth/deletion-receipt` — "did the deletion I asked for happen?"
 *
 * UNAUTHENTICATED ON PURPOSE, AND SAFE. A successful deletion destroys the
 * access token, the refresh token and the session row, so there is no
 * credential left that could authenticate this question. The receipt id is
 * the one secret whose purpose outlives the account: 256 bits the client
 * generated and persisted BEFORE asking for deletion, stored here only as a
 * SHA-256 hash.
 *
 * It reveals nothing. The response is a boolean and a timestamp; the endpoint
 * accepts only a value we never issue publicly, so it cannot be used to
 * discover whether any address, user or device has an account.
 */
export const deletionReceiptRequestSchema = z.object({
  receiptId: z.string().trim().min(16).max(256),
});
export type DeletionReceiptRequest = z.infer<typeof deletionReceiptRequestSchema>;

export const deletionReceiptResponseSchema = z.object({
  deleted: z.boolean(),
  /** Set only when `deleted` is true. */
  deletedAt: z.string().nullable(),
});
export type DeletionReceiptResponse = z.infer<typeof deletionReceiptResponseSchema>;
