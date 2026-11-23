# MiniDrama — API Documentation

**Status:** Contract proposal v0.1 — awaiting approval
**Base URL:** `https://api.minidrama.app/api/v1`
**Last updated:** 2026-11-15

This is the contract, not generated reference output. Once approved, every schema here is defined once in `packages/contracts` as a Zod schema, and the OpenAPI document is generated from those schemas — so this file and the running API cannot disagree without a type error.

---

## 1. Conventions

**Versioning.** The major version is in the path (`/api/v1`). Breaking changes mean `/v2`; additive fields do not. Mobile apps live on devices for a long time — a version in the path is cheap insurance.

**Response envelope.** Every response, success or failure, has the same shape:

```jsonc
// success
{ "success": true, "data": { /* ... */ }, "meta": { /* optional */ } }

// failure
{
  "success": false,
  "error": {
    "code": "EPISODE_LOCKED",
    "message": "This episode requires an active subscription.",
    "details": [{ "field": "episodeNumber", "message": "Required" }],
    "requestId": "req_01HXYZ..."
  }
}
```

`message` is always safe to show a user. Internal detail lives in the logs under `requestId` and never in the payload (CLAUDE.md §7, §11).

**Pagination.** Cursor-based on all list endpoints. Offset pagination skips and duplicates rows when the underlying list changes under the user, which it constantly does in a feed.

```
GET /dramas?limit=20&cursor=cmg3x...

"meta": { "nextCursor": "cmg4a...", "hasMore": true, "limit": 20 }
```

`limit` defaults to 20, max 50.

**Auth header.** `Authorization: Bearer <accessToken>`.

**Idempotency.** All non-GET endpoints that move money or coins require an `Idempotency-Key` header.

**Rate limits** (per IP for anonymous, per user when authenticated):

| Scope | Limit |
|---|---|
| Auth endpoints | 10 / 15 min |
| Playback token | 60 / min |
| Playback events | 240 / min |
| General reads | 120 / min |
| Admin writes | 60 / min |

Exceeding a limit returns `429 RATE_LIMITED` with `Retry-After`.

**Error codes** (stable, client-branchable):

`VALIDATION_ERROR` · `UNAUTHENTICATED` · `TOKEN_EXPIRED` · `FORBIDDEN` · `NOT_FOUND` · `RESOURCE_CONFLICT` · `EPISODE_LOCKED` · `SUBSCRIPTION_REQUIRED` · `INSUFFICIENT_COINS` · `PURCHASE_VERIFICATION_FAILED` · `RATE_LIMITED` · `UPLOAD_FAILED` · `INTERNAL_ERROR`

---

## 2. Authentication

**Implemented in M2.5.** Email and password, with the backend issuing its own
access and refresh tokens (ADR-07, ADR-37). Google Sign-In and phone OTP are
still ADR-06 and still deferred.

| Method | Path | Auth | Rate limit (per 15 min) | Purpose |
|---|---|---|---|---|
| POST | `/auth/register` | none | 5 per IP+email | Create an account; sends a confirmation email |
| POST | `/auth/login` | none | 10 per IP+email | Exchange credentials for a session |
| POST | `/auth/guest` | none | 5 per install, 60 per IP | Create or resume an anonymous session |
| POST | `/auth/refresh` | refresh token | 60 per IP | Rotate the token pair |
| POST | `/auth/logout` | access | — | Revoke this session, or all of them |
| GET | `/auth/me` | access | — | Current user, profile and verification state |
| POST | `/auth/change-password` | access | — | Change the password; revokes every session |
| POST | `/auth/forgot-password` | none | 5 per IP+email | Request a reset link |
| POST | `/auth/reset-password` | none | 30 per IP | Set a new password from an emailed token |
| POST | `/auth/verify-email` | none | 30 per IP | Confirm an address from an emailed token |
| POST | `/auth/resend-verification` | access | 5 per IP | Send the confirmation email again |
| POST | `/auth/merge` | access | 5 per IP+email | Upgrade the calling guest into an account (AUTH-06) |
| DELETE | `/auth/account` | access | 5 per user | Delete the calling account, immediately (AUTH-09) |
| POST | `/auth/deletion-receipt` | none | 30 per IP | Ask whether a deletion was recorded (M2.6) |

Not yet implemented: `POST /auth/google`, and the web-initiated deletion pair
`POST /auth/request-deletion` / `POST /auth/confirm-deletion`, which are
designed but wait on a real mail sender (ADR-42).

Also public, outside `/api`: **`GET /account-deletion`** — a static page
explaining how to delete an account and what that removes. No form, no input,
no JavaScript, so it has no enumeration surface and no unauthenticated deletion
path.

### The rules this surface is built around

**No request carries a user id.** Not one schema in the authentication
contract has a `userId` field. The caller is whoever their credential says
they are, resolved by middleware; a body-supplied id would be an ownership
claim the server has to disprove (CLAUDE.md §11).

**No response says whether an account exists.** Registration, login and
password reset answer identically either way, and login spends the same CPU on
an unknown address as on a real one. See ADR-39 for what that costs.

**POST `/auth/register`**

```jsonc
// request
{ "email": "priya@example.com", "password": "at least twelve chars", "displayName": "Priya" }

// 201 — IDENTICAL whether or not the address was already taken
{ "success": true, "data": { "accepted": true, "message": "If that email address can receive mail, we have sent a message to it. Check your inbox." } }
```

It deliberately returns **no session**: a byte-identical response for both
cases cannot carry one. The duplicate path creates nothing and emails the real
owner a notice instead.

**POST `/auth/login`**

```jsonc
// request
{ "email": "priya@example.com", "password": "...", "deviceId": "a3f...", "platform": "android" }

// 200
{
  "success": true,
  "data": {
    "accessToken": "eyJ...",        // JWT, 15 min, HS256, iss+aud validated
    "refreshToken": "rt_...",       // opaque, 60 days, rotates on every use
    "expiresIn": 900,
    "emailVerified": false,
    "user": { "id": "cmg...", "displayName": "Priya", "isAnonymous": false, ... }
  }
}

// 401 — the same body for a wrong password AND an unknown account
{ "success": false, "error": { "code": "UNAUTHENTICATED", "message": "That email address and password do not match an account." } }
```

`user` is the same `UserProfile` the library module returns. `emailVerified`
is display-only; the server re-reads `User.emailVerifiedAt` wherever
verification actually matters.

**POST `/auth/guest`**

```jsonc
// request
{ "deviceId": "a3f...", "platform": "android" }
```

Creates a real `User` row with `isAnonymous = true`, or resumes the existing
one for that install. The device id is a label, not a credential: it resumes a
session only when a live, unrevoked session row is bound to it, so a guessed
id yields a *new* guest account rather than somebody else's (ADR-41).

**POST `/auth/refresh`**

Rotates. The presented token is revoked and a successor issued, atomically.

**Presenting an already-rotated token revokes the whole session family** and
returns 401 — a replay means two parties hold tokens from one chain, and there
is no way to tell which holder is legitimate (ADR-40). Clients must therefore
collapse concurrent refreshes into one request, or they will trigger this
against themselves; see ADR-45.

**POST `/auth/merge`**

The guest is identified by the **access token**, never by a body field — a
`guestUserId` parameter would let anyone adopt anyone's anonymous account and
inherit its history.

```jsonc
// request
{ "email": "priya@example.com", "password": "...", "displayName": "Priya" }

// 200
{
  "success": true,
  "data": {
    "session": { "accessToken": "...", "refreshToken": "...", "expiresIn": 900, "user": {...} },
    "moved": { "watchHistory": 3, "dramaProgress": 1, "favorites": 2, "playbackEvents": 41 }
  }
}
```

If the address is free the guest row is promoted in place and `moved` is all
zeros — nothing had to move. If the address already has an account, **that
account's password is required** and the guest's activity is folded in;
`moved` reports what actually crossed over. Rows that would collide are
dropped and the registered account's keep their values (ADR-41).

**DELETE `/auth/account`** (M2.6)

```jsonc
// request — password omitted for a guest, which has none (ADR-41)
// header: Idempotency-Key: <256-bit client-generated receipt id>
{ "password": "...", "confirm": "DELETE" }

// 200
{ "success": true, "data": {
    "accepted": true,
    "deletedAt": "2026-11-18T10:14:22.901Z",
    "removed": { "watchHistory": 128, "dramaProgress": 9, "favorites": 14,
                 "sessions": 3, "verificationTokens": 1 },
    "receiptRecorded": true,
    "message": "Your account and viewing history have been deleted."
} }
```

Deletion is **immediate and irreversible**. One transaction nulls every direct
identifier on `User`, sets `status = DELETED`, moves `tokensValidFrom` forward
and hard-deletes the profile, sessions, verification tokens, watch history,
drama progress and favourites — decrementing `Drama.favoriteCount` as it goes.
`PlaybackEvent.userId` is nulled immediately afterwards, outside that
transaction, with its own recorded status (ADR-49). The address is freed: the
same email may register again and gets a genuinely new account.

**A wrong or missing password is 403, not 401** (ADR-46). The caller is
authenticated — it is the password that was refused, and the session stays
usable. This matters because a *successful* deletion makes every later request
401, so collapsing the two would leave a client unable to tell "I typed it
wrong" from "it already worked".

**POST `/auth/deletion-receipt`**

```jsonc
// request — no credential; there is none left to present
{ "receiptId": "<the id sent as Idempotency-Key>" }

// 200
{ "success": true, "data": { "deleted": true, "deletedAt": "2026-11-18T10:14:22.901Z" } }
{ "success": true, "data": { "deleted": false, "deletedAt": null } }
```

**Clients must not infer deletion from a 401.** A deletion destroys the
credential that would ask again, so a 401 afterwards means the session is dead,
the token expired, or the deletion succeeded with its response lost. The
receipt is the only way to tell. The client generates the id and persists it
**before** sending the delete; on any 401 or transport failure it asks here,
and tears down local data only on `deleted: true` (ADR-47).

An unknown id answers `deleted: false`, not 404 — it reveals nothing either
way, and the endpoint accepts only a value the server never issues.

### Token lifecycle

| | Access | Refresh |
|---|---|---|
| Form | JWT, HS256 | Opaque, 32 random bytes |
| Lifetime | 15 min | 60 days, rotating |
| Stored | Client memory only | SHA-256 hash in `Session` (ADR-38) |
| Validated | signature, `iss`, `aud`, `exp`, `typ` | row lookup, revocation, expiry |
| Revocable | via `User.tokensValidFrom` | immediately, per row or per family |

A password change or reset moves `User.tokensValidFrom` forward, which
invalidates every access token already in circulation rather than waiting out
the fifteen minutes (ADR-40).

`TOKEN_EXPIRED` is returned separately from `UNAUTHENTICATED` because clients
act on the difference: expired means refresh and retry silently, anything else
means the session is finished.

### Error codes used here

| Code | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Malformed body; an expired, consumed or unknown emailed token |
| `UNAUTHENTICATED` | 401 | Wrong credentials, unknown account, suspended account, dead session |
| `TOKEN_EXPIRED` | 401 | The access token's `exp` has passed, or it predates a revocation |
| `FORBIDDEN` | 403 | Changing a password on an account that has none (a guest); a wrong or missing password on account deletion (ADR-46) |
| `RESOURCE_CONFLICT` | 409 | Merging an account that is already registered |
| `RATE_LIMITED` | 429 | Over the allowance above; carries `Retry-After` |
| `SERVICE_UNAVAILABLE` | 503 | Password reset with no mail delivery configured (ADR-42) |

---

## 3. Authorisation Matrix

| Route group | Guest | User | Analyst | Moderator | ContentManager | SuperAdmin |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Catalogue reads | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Playback token — free episode | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Playback token — premium | ❌ | entitlement | — | — | — | — |
| History / favourites | ✅* | ✅ | — | — | — | — |
| Delete own account | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Purchases | ❌ | ✅ | — | — | — | — |
| Admin analytics | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Content reports queue | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| Drama / episode CRUD | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| User suspension | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| Admin user management | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

\* Guests get history and favourites against their anonymous account, which merges on sign-in. **Implemented in M2.5** — `POST /auth/guest` and `POST /auth/merge`.

Account deletion is **own-account only**, for guests and registered users
alike. No admin role can delete a consumer account in M2.6; admin-initiated
deletion arrives with the admin module in M5 and will write the same
`AccountDeletion` row with `source = ADMIN`.

---

## 4. Catalogue

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/home` | optional | Composed home payload — one round trip |
| GET | `/dramas` | optional | Filters: `languageId`, `categoryId`, `status`, `sort` |
| GET | `/dramas/:idOrSlug` | optional | Detail with cast, categories, season summaries |
| GET | `/dramas/:id/episodes` | optional | Paginated; includes per-user lock and watched state |
| GET | `/dramas/:id/similar` | optional | Rule-based (ADR-08) |
| GET | `/categories` | none | Active categories |
| GET | `/languages` | none | Active languages |
| GET | `/search` | optional | `q`, `languageId`, `categoryId` |
| GET | `/search/trending` | none | DISC-07 |

**GET `/home`** returns every rail in one response. Five separate rail requests on a cold start is five chances to be slow on a weak connection.

```jsonc
{
  "success": true,
  "data": {
    "featured": { "id": "cmg...", "title": "Kadhal Nizhal", "coverUrl": "https://cdn...", "trailerPlaybackId": "AbC..." },
    "rails": [
      { "key": "continue_watching", "title": "Continue Watching",
        "items": [{ "dramaId": "cmg...", "title": "...", "posterUrl": "...",
                    "lastEpisodeNumber": 7, "positionSec": 43, "totalEpisodes": 60 }] },
      { "key": "trending",  "title": "Trending Now",      "items": [ /* DramaCard */ ] },
      { "key": "new",       "title": "Recently Released", "items": [ /* DramaCard */ ] },
      { "key": "recommended","title": "For You",          "items": [ /* DramaCard */ ] }
    ]
  }
}
```

Empty rails are omitted, not returned empty — the client renders what it is given rather than deciding which rails exist.

**DramaCard** (the one shape used everywhere a drama appears in a list):

```jsonc
{
  "id": "cmg...", "slug": "kadhal-nizhal", "title": "Kadhal Nizhal",
  "posterUrl": "https://cdn.minidrama.app/posters/...webp",
  "language": { "code": "ta", "name": "Tamil" },
  "categories": ["Romance", "Thriller"],
  "contentRating": "UA_13",
  "totalEpisodes": 60,
  "isFavorited": false
}
```

Image URLs are resolved server-side from R2 keys, so the CDN domain is a backend concern and changing it never requires an app release.

**GET `/dramas/:id/episodes`** — each item carries the viewer's state so the list needs no second call:

```jsonc
{
  "id": "cmg...", "episodeNumber": 7, "title": "Episode 7",
  "thumbnailUrl": "https://cdn...", "durationSec": 92,
  "accessType": "PREMIUM",
  "isLocked": true,                      // computed per caller
  "unlockOptions": ["SUBSCRIPTION", "COIN", "REWARDED_AD"],
  "coinPrice": 20,
  "watchState": { "positionSec": 0, "isCompleted": false }
}
```

---

## 5. Playback — the security-critical path

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/playback/episodes/:id/token` | optional | Entitlement check + signed Mux token |
| POST | `/playback/events` | optional | Batched playback telemetry |
| GET | `/playback/episodes/:id/next` | optional | Next episode + prewarm token (PLY-03) |

**POST `/playback/episodes/:id/token`**

```jsonc
// 200
{
  "success": true,
  "data": {
    "playbackUrl": "https://stream.mux.com/AbC123.m3u8?token=eyJ...",
    "expiresAt": "2026-11-15T12:30:00Z",
    "durationSec": 92,
    "startPositionSec": 43,
    "subtitles": [{ "languageCode": "ta", "label": "Tamil", "url": "https://cdn...", "isDefault": true }],
    "nextEpisodeId": "cmg..."
  }
}

// 403 — locked
{
  "success": false,
  "error": {
    "code": "EPISODE_LOCKED",
    "message": "Unlock this episode to keep watching.",
    "details": [{ "field": "unlockOptions", "message": "SUBSCRIPTION,COIN,REWARDED_AD" }]
  }
}
```

Server-side rules on this endpoint, in order: episode and drama both `PUBLISHED` → entitlement evaluated from the database (never from the request) → token signed with the Mux private key held only in backend env → `exp` set to at least twice the episode duration so playback cannot expire mid-stream.

**POST `/playback/events`** — batched, fire-and-forget. Shape defined by
`playbackEventBatchSchema` in `packages/contracts` (implemented client-side in
M2.2; server-side in M2.3):

```jsonc
{
  "events": [
    {
      "eventId": "9f1c0f6e-...",          // client-generated; the idempotency key
      "sessionId": "ps_9f1c0f6e-...",     // one per visit to the player screen
      "dramaId": "cmg...",
      "episodeId": "cmg...",
      "type": "playback_started",
      "occurredAt": "2026-11-16T12:00:00.000Z",
      "positionSec": 0,
      "durationSec": 92,                  // null until the player resolves it
      "errorCode": null,                  // only on playback_failed
      "context": { "platform": "android", "appVersion": "0.1.0" }
    }
  ]
}
```

**Event types** (eight; see the contract for what each one means):
`playback_started` · `playback_paused` · `playback_resumed` ·
`playback_progress` · `playback_completed` · `playback_failed` ·
`episode_changed` · `playback_abandoned`.

`playback_progress` is the heartbeat, emitted every 15 seconds and on seeks
(SYSTEM_ARCHITECTURE.md §8).

**Response** names what was durably stored:

```jsonc
{ "success": true, "data": { "acceptedEventIds": ["9f1c0f6e-...", "..."] } }
```

Not a bare `202`. The client deletes only the events the server names, and
retries the rest — it must never drop something it cannot prove was stored.
A partial accept is a normal outcome, not an error.

**Three rules ingestion must honour** (ADR-25):

1. `eventId` is the idempotency key. The client delivers at least once and
   will resend a batch whose response was lost, so a repeat must be a no-op.
2. `occurredAt` is the device's clock and is not trusted. Record a server-side
   receipt time alongside it.
3. `context` is an allow-list of two fields. Do not accept or store more; the
   client deliberately sends no device or personal identifiers.

Clients never block playback on this call, and a failure is queued and retried
rather than surfaced — telemetry must never degrade the viewing experience.

---

## 6. Library

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/me/history` | required | Paginated watch history |
| PUT | `/me/history/:episodeId` | required | Upsert position; also updates `DramaProgress` |
| GET | `/me/continue-watching` | required | HIST-04 |
| GET | `/me/favorites` | required | Paginated |
| POST | `/me/favorites/:dramaId` | required | Idempotent add |
| DELETE | `/me/favorites/:dramaId` | required | Idempotent remove |
| GET | `/me/profile` | required | |
| PATCH | `/me/profile` | required | Display name, language, genres, autoplay |
| GET | `/me/notifications` | required | Paginated |
| POST | `/me/devices` | required | Register a push token |

`PUT /me/history/:episodeId` accepts `{ positionSec, watchedSec }` and is safe to call repeatedly — the client flushes a queue on reconnect and may replay (HIST-06). The server takes the maximum position, never a lower one, so an out-of-order replay cannot rewind a user's progress.

---

## 7. Monetisation

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/plans` | optional | Active subscription plans |
| POST | `/purchases/google/verify` | required | Verify a Play purchase token server-side |
| GET | `/me/subscription` | required | Current status |
| POST | `/me/subscription/restore` | required | MON-08 |
| GET | `/me/wallet` | required | Coin balance |
| POST | `/me/wallet/purchase` | required | Coin pack via Play |
| POST | `/episodes/:id/unlock` | required | Spend coins — `Idempotency-Key` required |
| POST | `/episodes/:id/unlock-with-ad` | required | Rewarded-ad unlock, server-verified |

**POST `/purchases/google/verify`** takes `{ productId, purchaseToken, orderId }`, verifies against the Play Developer API, and writes `Payment` + `Subscription` in one transaction. A purchase is never trusted from the client's own report of success; Play is the source of truth (ARCH R-3).

---

## 8. Admin

All under `/admin`, all requiring an admin token and a role check.

**Content**

| Method | Path | Min role |
|---|---|---|
| GET/POST | `/admin/dramas` | ContentManager |
| GET/PATCH/DELETE | `/admin/dramas/:id` | ContentManager |
| POST | `/admin/dramas/:id/publish` · `/unpublish` | ContentManager |
| GET/POST | `/admin/dramas/:id/seasons` | ContentManager |
| GET/POST | `/admin/seasons/:id/episodes` | ContentManager |
| GET/PATCH/DELETE | `/admin/episodes/:id` | ContentManager |
| POST | `/admin/episodes/:id/upload-url` | ContentManager |
| GET | `/admin/episodes/:id/status` | ContentManager |
| POST | `/admin/episodes/:id/subtitles` | ContentManager |
| POST | `/admin/uploads/image-url` | ContentManager |

**POST `/admin/episodes/:id/upload-url`** returns `{ uploadUrl, uploadId, expiresAt }`. The browser PUTs the file directly to Mux; video bytes never pass through our API (ARCH §7).

**Users, moderation, analytics**

| Method | Path | Min role |
|---|---|---|
| GET | `/admin/users` · `/admin/users/:id` | Moderator |
| PATCH | `/admin/users/:id/status` | Moderator |
| GET | `/admin/reports` | Moderator |
| PATCH | `/admin/reports/:id` | Moderator |
| GET | `/admin/analytics/overview` | Analyst |
| GET | `/admin/analytics/dramas/:id` | Analyst |
| GET | `/admin/analytics/episodes/:id` | Analyst |
| GET | `/admin/analytics/retention` | Analyst |
| GET/POST | `/admin/admins` | SuperAdmin |
| GET | `/admin/audit-logs` | SuperAdmin |

Analytics endpoints read `EpisodeDailyStat` only, never raw `PlaybackEvent` (ARCH R-7). Every mutating admin call writes an `AdminAuditLog` row in the same transaction as the change.

---

## 9. Webhooks (inbound)

| Path | Source | Verification |
|---|---|---|
| `POST /webhooks/mux` | Mux | `Mux-Signature` HMAC over the **raw** body, 5-minute timestamp tolerance |
| `POST /webhooks/play-rtdn` | Google Pub/Sub | OIDC token verification |

Both are idempotent on the provider event ID and both return `200` quickly, doing the real work in a background job — a provider that times out will retry, and retries must be harmless.

Mux events consumed: `video.asset.ready` (store playbackId, duration, aspect ratio; mark READY), `video.asset.errored` (mark FAILED, surface the reason in admin), `video.upload.cancelled`.

---

## 10. Health

| Path | Purpose | Status codes |
|---|---|---|
| `GET /health` | Liveness — the process is up. Checks no dependency: restarting the process will not fix an outage elsewhere. | always `200` while serving |
| `GET /ready` | Readiness — should this instance receive traffic? | `200` when every dependency is `ok`, `503` otherwise |

Both are also mounted under the versioned prefix (`/api/v1/health`, `/api/v1/ready`); the unversioned paths are the stable ones for orchestrators and uptime checks.

`/ready` returns a `dependencies` array. As of M1.3 it holds one entry:

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "minidrama-api",
    "version": "0.1.0",
    "environment": "development",
    "uptimeSeconds": 42,
    "timestamp": "2026-11-15T15:42:40.619Z",
    "dependencies": [
      { "name": "postgres", "status": "ok", "latencyMs": 30, "message": "Connection healthy" }
    ]
  }
}
```

When Postgres is unreachable the entry becomes `{"name": "postgres", "status": "down", "message": "Database unreachable"}` and the response is `503`. **The `message` is fixed text, never the driver's.** Database errors name the host, port and user; `/ready` is unauthenticated, so none of that may appear in a response body (CLAUDE.md §11). The real error goes to the log.

The video provider joins this list in M4.

---

## 11. Open API Questions

1. **Home rail composition** — server-driven (as proposed) or client-configured? Server-driven lets rails be reordered without an app release; it also means the client cannot A/B rail order on its own. Recommend server-driven.
2. **Episode-list page size** — 20 is the proposed default for a 60-episode season. Worth validating against the real grid design.
3. **Heartbeat interval** — 15s proposed. Shorter means better resume precision and more write volume; this is a direct trade against R-7.
4. **Guest playback tokens** — rate-limited by IP in the proposal. Shared-NAT mobile networks in India will cause false positives; a device-bound guest token is the better key. Needs a decision before launch.

   **Partially addressed in M2.4.** `POST /playback/events` now keys its rate
   limit on the authenticated user id wherever there is one, falling back to
   IP only for unauthenticated callers, and the limit is set generously (120
   requests per minute) precisely because the IP fallback is unreliable. The
   device-bound guest token is still the real fix and is still open; M2.5's
   authentication work is where it belongs. The limiter is also per process,
   so it is not yet correct behind more than one instance (ADR-34).
