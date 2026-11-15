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

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/session` | none | Exchange a Firebase ID token for our access + refresh tokens |
| POST | `/auth/guest` | none | Create or resume an anonymous session |
| POST | `/auth/refresh` | refresh token | Rotate the token pair |
| POST | `/auth/logout` | access | Revoke the current session |
| POST | `/auth/merge` | access | Merge an anonymous account into the signed-in one (AUTH-06) |
| GET | `/auth/me` | access | Current user, profile and entitlement summary |
| DELETE | `/auth/account` | access | Request account deletion (AUTH-09) |

**POST `/auth/session`**

```jsonc
// request
{ "firebaseIdToken": "eyJhbGci...", "deviceId": "a3f...", "platform": "android" }

// 200
{
  "success": true,
  "data": {
    "accessToken": "eyJ...",          // 15 min
    "refreshToken": "rt_...",         // 60 days, rotates on every refresh
    "expiresIn": 900,
    "user": {
      "id": "cmg...", "displayName": "Priya", "isAnonymous": false,
      "preferredLanguage": { "id": "cmg...", "code": "ta", "name": "Tamil" },
      "entitlement": { "hasActiveSubscription": true, "expiresAt": "2026-12-15T00:00:00Z", "coinBalance": 120 }
    }
  }
}
```

`entitlement` is informational for UI only. It is never the basis of a playback decision — that is re-evaluated server-side on every token request (CLAUDE.md §11).

---

## 3. Authorisation Matrix

| Route group | Guest | User | Analyst | Moderator | ContentManager | SuperAdmin |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Catalogue reads | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Playback token — free episode | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Playback token — premium | ❌ | entitlement | — | — | — | — |
| History / favourites | ✅* | ✅ | — | — | — | — |
| Purchases | ❌ | ✅ | — | — | — | — |
| Admin analytics | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Content reports queue | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| Drama / episode CRUD | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| User suspension | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| Admin user management | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

\* Guests get history and favourites against their anonymous account, which merges on sign-in.

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

**POST `/playback/events`** — batched, fire-and-forget:

```jsonc
{
  "sessionId": "ps_01HX...",
  "events": [
    { "episodeId": "cmg...", "type": "START",     "positionSec": 0,  "at": "2026-11-15T12:00:00Z" },
    { "episodeId": "cmg...", "type": "HEARTBEAT", "positionSec": 15, "deltaSec": 15, "at": "..." },
    { "episodeId": "cmg...", "type": "COMPLETE",  "positionSec": 92, "deltaSec": 7,  "at": "..." }
  ]
}
```

Returns `202 Accepted` with no body. Clients never block playback on this call, and a failure here is logged and dropped — telemetry must never degrade the viewing experience.

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

| Path | Purpose |
|---|---|
| `GET /health` | Liveness — process is up |
| `GET /ready` | Readiness — DB reachable, Mux credentials valid |

---

## 11. Open API Questions

1. **Home rail composition** — server-driven (as proposed) or client-configured? Server-driven lets rails be reordered without an app release; it also means the client cannot A/B rail order on its own. Recommend server-driven.
2. **Episode-list page size** — 20 is the proposed default for a 60-episode season. Worth validating against the real grid design.
3. **Heartbeat interval** — 15s proposed. Shorter means better resume precision and more write volume; this is a direct trade against R-7.
4. **Guest playback tokens** — rate-limited by IP in the proposal. Shared-NAT mobile networks in India will cause false positives; a device-bound guest token is the better key. Needs a decision before launch.
