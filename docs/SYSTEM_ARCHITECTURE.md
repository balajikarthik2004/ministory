# MiniDrama — System Architecture

**Status:** Proposal v0.1 — awaiting approval
**Last updated:** 2026-11-15

This document proposes the system architecture. Items marked **[APPROVAL NEEDED]** extend or deviate from CLAUDE.md and must be signed off before implementation (CLAUDE.md §16 rule 7).

---

## 1. System Context

```
┌──────────────┐        ┌──────────────┐        ┌───────────────┐
│ Mobile app   │        │ Admin web    │        │ Mux webhooks  │
│ Expo / RN    │        │ React + Vite │        │ Play RTDN     │
└──────┬───────┘        └──────┬───────┘        └───────┬───────┘
       │ HTTPS/REST            │ HTTPS/REST             │ HTTPS
       └───────────────┬───────┴────────────────────────┘
                       ▼
            ┌──────────────────────┐
            │  API (Node/Express)  │
            │  modular monolith    │
            └──┬────────┬──────┬───┘
               │        │      │
     ┌─────────▼──┐  ┌──▼───┐  └──────────────┐
     │ PostgreSQL │  │ Jobs │                 ▼
     │  (Prisma)  │  │queue │        ┌─────────────────┐
     └────────────┘  └──────┘        │ External        │
                                     │ Mux · R2 · FCM  │
                                     │ Play API · GA4  │
                                     └─────────────────┘
                                              │
   Video bytes never pass through the API ────┘
   Clients fetch HLS directly from the Mux CDN using a signed token.
```

The single most important property of this design: **video bytes never traverse our backend.** The API issues short-lived signed playback tokens; the client streams from the Mux CDN. This is what makes a small backend able to serve a large audience.

---

## 2. Architectural Style

**A modular monolith for the backend, not microservices.**

At 50k MAU with one team, microservices buy distributed-systems problems and nothing else. Each of the 17 modules in CLAUDE.md §7 becomes a self-contained folder with its own router, controller, service, repository and validators, and modules talk to each other only through exported service functions — never by reaching into another module's repository. That discipline is what makes a later extraction cheap if one module (analytics ingestion is the likely candidate) outgrows the monolith.

**Enforcement:** an ESLint `no-restricted-imports` rule forbids importing `modules/<x>/repository` from outside `modules/<x>`. Architecture that is not enforced by a linter decays within a month.

---

## 3. Monorepo Layout **[APPROVED 2026-11-15 — implemented in M1.1]**

CLAUDE.md §4 specifies `mobile/`, `admin/`, `backend/`, `docs/`. That layout has one structural gap: the API contract — request/response types and validation schemas — would be hand-duplicated in three places, and the copies will drift. The usual symptom is a mobile release that breaks on a backend field rename nobody type-checked.

**Proposal:** keep the three apps exactly as specified, move them under `apps/`, and add a `packages/` area for shared code.

```
MiniDrama/
├── apps/
│   ├── mobile/                 # Expo — structure per CLAUDE.md §4
│   │   ├── app/                # expo-router routes
│   │   ├── components/ features/ hooks/ services/
│   │   ├── store/ constants/ assets/ types/ utils/
│   ├── admin/
│   │   └── src/
│   │       ├── components/ pages/ features/ hooks/
│   │       ├── services/ layouts/ types/ utils/
│   └── backend/
│       ├── prisma/             # schema.prisma, migrations, seed
│       └── src/
│           ├── config/         # env parsing (zod), constants
│           ├── modules/        # the 17 modules, each self-contained
│           ├── middleware/     # auth, rbac, rate-limit, error handler
│           ├── routes/         # version router composition only
│           ├── services/       # cross-cutting: mux, storage, mailer
│           ├── jobs/           # queue workers + schedules
│           ├── utils/ validators/ types/
├── packages/
│   ├── contracts/              # zod schemas + inferred TS types + OpenAPI
│   ├── config/                 # shared tsconfig / eslint / prettier bases
│   └── ui-tokens/              # design tokens, one source for RN + web
├── docs/
├── .github/workflows/
├── CLAUDE.md  README.md  .gitignore
├── package.json  pnpm-workspace.yaml  turbo.json
```

### Why `packages/contracts` earns its place

It holds Zod schemas for every API request and response. The backend validates with them, the mobile and admin clients parse with them, and OpenAPI is generated from them. One definition, three consumers, compile-time breakage instead of runtime surprise. This directly serves CLAUDE.md §10 ("validate untrusted data at runtime") and §16 rule 13 ("do not invent API responses or database fields") — with a shared contract, inventing a field is a type error.

**Dependency rule:** `apps/*` may depend on `packages/*`. `packages/*` never depend on `apps/*`. No app ever imports from another app. This preserves the CLAUDE.md §4 requirement that the three apps stay independently maintainable.

### Tooling **[APPROVED 2026-11-15 — implemented in M1.1]**

| Choice | Decision | Why |
|---|---|---|
| Package manager | **pnpm workspaces** with `node-linker=hoisted` | Expo's Metro bundler does not resolve pnpm's symlinked store reliably; hoisted mode is the documented Expo monorepo path. |
| Task runner | **Turborepo** | Caches typecheck/lint/test per package so CI stays under a few minutes as the repo grows. |
| Fallback | npm workspaces, no Turbo | Held in reserve in case pnpm fought Metro. Not needed — see below. |

Node ≥ 22 (developed on 24.15.0). **TypeScript 6.0.3**, `strict: true` with `noUncheckedIndexedAccess` on.

The TypeScript version is pinned by two constraints that cross: `typescript-eslint@8` supports `<6.1.0` (so TypeScript 7 breaks linting outright), and Expo SDK 58 expects `~6.0.3`. 6.0.3 is the only version satisfying both — see DECISIONS.md ADR-11.

**M1.1 outcome.** pnpm + Expo needed no fallback. A full Android Metro bundle (1,227 modules) exports cleanly with the monorepo `metro.config.js`, and `pnpm peers check` reports no issues. The fallback option is withdrawn.

---

## 4. Mobile Architecture

**Layering.** `app/` holds routes only and contains no business logic. `features/<name>/` owns the screens, components, hooks and API calls for one domain. `services/` holds the API client, secure storage and the analytics wrapper. This satisfies CLAUDE.md §10 "separate UI and business logic" by making the separation structural rather than a convention people forget.

**State, split by kind — the single most important mobile decision:**

| Kind of state | Owner | Examples |
|---|---|---|
| Server state | TanStack Query | dramas, episodes, history, favourites |
| Global client state | Zustand | session, selected language, player settings |
| Ephemeral UI state | `useState` | sheet open, scrub position |

Server data is never copied into Zustand. Mirroring server data in a client store is the most common source of stale-UI bugs in this kind of app, and it is avoidable by rule rather than by discipline.

**Navigation.** Expo Router file-based routing, with route groups: `(auth)`, `(tabs)`, `(player)`. The player is a modal route outside the tab bar so it can own the full screen and its own gesture handling.

**The player feed — the hard part.** A vertically-paged list of episodes, built on FlashList with `pagingEnabled`, where:

- At most **three** `expo-video` player instances exist at a time: previous, current, next. Index change rotates the pool rather than mounting a new player — mounting a player per episode is what causes OOM kills on low-memory devices.
- The next episode's playback token is fetched and its HLS manifest prewarmed as soon as the current episode starts.
- Players are explicitly released on unmount (CLAUDE.md §13).
- All of this lives behind one `useEpisodeFeed` hook so the pooling logic has exactly one home.

This is the highest-risk component in the product and is the subject of a dedicated spike in Milestone 1 (see §10 R-1).

**Offline.** TanStack Query holds last-seen lists; watch progress and playback telemetry are persisted in **SQLite** (`expo-sqlite`) and flushed on reconnect (HIST-06).

> **Corrected in M2.2.** This section previously specified AsyncStorage. The
> implementation uses SQLite, because a durable outbox needs transactions and
> a query language that AsyncStorage does not have: claim-and-mark-in-flight
> must be atomic, the dispatch query is "pending rows whose backoff has
> elapsed, oldest first, limit N", and attempt counts and retry windows belong
> on the row. Full reasoning in DECISIONS.md **ADR-23**.
>
> SQLite here is **mobile-local only** — an event outbox and the viewer's own
> progress. PostgreSQL remains the system of record; the local store is not a
> copy of the server schema and must not become one.

---

## 5. Backend Architecture

### Request pipeline

```
request → helmet → cors → request-id → body parse (size-capped)
        → rate limiter → authenticate → authorize(role)
        → validate(zod: params|query|body)
        → controller → service → repository (Prisma) → PostgreSQL
        → response envelope
        → centralized error handler → structured log
```

Every layer is mandatory for every route. Validation and error handling are not per-route choices.

### Module anatomy

```
modules/episodes/
├── episode.routes.ts       # paths, middleware wiring — no logic
├── episode.controller.ts   # HTTP in/out only, no business rules
├── episode.service.ts      # business rules, transactions, orchestration
├── episode.repository.ts   # all Prisma access for this module
├── episode.schema.ts       # re-exports from packages/contracts
└── episode.types.ts
```

A controller that touches Prisma, or a service that touches `req`/`res`, is a review rejection. The repository layer exists so that query shape, index usage and N+1 problems are reviewable in one file per module instead of scattered across handlers.

### Error handling

One `AppError` class carrying an HTTP status, a stable machine-readable `code`, and a safe client message. Prisma errors are translated at the repository boundary — `P2002` becomes `409 RESOURCE_CONFLICT`, never a raw driver string. Unmapped errors become a generic 500 with a correlation ID in both the log and the response. CLAUDE.md §7: internal database errors are never exposed.

### Background jobs **[APPROVAL NEEDED]**

Several P0/P1 requirements cannot be done in a request: scheduled publication (ADM-07), notification fan-out (NOT-02), Mux webhook retries, nightly analytics rollups, failed-purchase reconciliation.

**Recommendation: pg-boss** — a job queue that runs inside the existing PostgreSQL instance. It adds no new infrastructure, survives restarts, and supports scheduling and retries. BullMQ is more capable but requires Redis, which the CLAUDE.md stack does not include. If Redis arrives later for caching, revisiting this is cheap.

### Caching

No cache in v1 beyond HTTP `Cache-Control` on public catalogue endpoints (`s-maxage=60`) and Postgres' own buffer cache. Introduce Redis only when p95 measurements justify it — a cache added before measurement usually hides the missing index that was the real problem.

---

## 6. Authentication & Authorisation

**Implemented in M2.5** for email and password. Approved 2026-11-17, ADR-37.

**Consumer (mobile), as built:**

1. Email and password, verified against an Argon2id hash by our own backend.
   No external identity provider is involved.
2. The backend issues **its own** access token (JWT, HS256, 15 min, `iss` and
   `aud` validated) and refresh token (opaque, 60 days, rotating, SHA-256 at
   rest — ADR-38).
3. Every subsequent call uses our access token.
4. A refresh presented twice revokes the whole session family (ADR-40).

**Why not a managed provider.** Whatever proves identity, step 2 is ours
regardless: roles, entitlement and ban status must be server-side and
revocable, and CLAUDE.md §11 is only satisfiable that way. A managed provider
would not remove that work, only add a vendor beside it. The free tiers were
checked rather than assumed, and the comparison is in ADR-37.

**Firebase is still the plan for what it is actually good at.** ADR-06 stands
unchanged for Google Sign-In and phone OTP — building phone OTP ourselves
means an SMS provider and DLT registration in India, and buys nothing. It
arrives as a second `IdentityProvider` behind the same boundary, which is one
branch in `bootstrap/identity.ts`. `User.firebaseUid` is already in the schema
and nullable.

**Google Sign-In is deferred for a different reason than cost.** It needs an
OAuth client in Google Cloud Console, which is an external account M2.5 was
scoped not to create. `POST /auth/google` drops into the existing module.

Why not use the Firebase token directly: roles, subscription entitlement and ban status must be ours, evaluated server-side and revocable instantly. Firebase tokens cannot be revoked mid-flight and carry no entitlement claims we control. CLAUDE.md §11 — "never trust client-side subscription status" — is only satisfiable if the backend owns the token.

**Guest (implemented M2.5):** `POST /auth/guest` produces a real `User` row with `isAnonymous = true`, bound to a client-generated device id so the account survives a restart. On sign-in the anonymous account's history, progress and favourites are merged into the permanent account inside one transaction (AUTH-06). Conflicting rows keep the registered account's values rather than failing the merge — ADR-41.

**Admin:** entirely separate. Email + password (argon2id), backend-issued JWT, mandatory TOTP 2FA for SuperAdmin, in a distinct token audience so a consumer token can never authenticate an admin route. Admin accounts are created by invitation only — no public signup path exists.

**Token storage (implemented M2.5):** `expo-secure-store` on mobile (Keychain/Keystore) holds the refresh token; the access token lives in memory only and is never persisted — it expires in fifteen minutes and would be a second credential at rest for nothing. Admin will use an httpOnly, Secure, SameSite=Strict refresh cookie. Never `localStorage`, never AsyncStorage.

**RBAC:** roles on the user, permissions checked by an `authorize(...)` middleware driven by a central permission matrix, documented in API_DOCUMENTATION.md §3.

---

## 7. Video Pipeline

### Upload (admin → Mux, bypassing our backend)

```
Admin clicks Upload
  → POST /admin/episodes/:id/upload-url          (admin JWT required)
  → backend calls Mux Direct Uploads API, stores the upload id
  → returns a single-use, time-limited URL
  → browser PUTs the file straight to Mux (bytes never touch our API)
  → Mux transcodes
  → webhook: video.asset.ready → store playbackId, duration, aspect ratio
  → episode.processingStatus = READY
```

The admin UI polls episode status; operators see "Processing / Ready / Failed", never a Mux asset ID.

**Webhook security:** every Mux webhook verifies the `Mux-Signature` HMAC against the raw request body before parsing, rejects timestamps older than five minutes, and is idempotent on the Mux event ID (a webhook will be delivered twice eventually; it must be harmless).

### Playback authorisation — the security-critical path

```
Client: POST /playback/episodes/:id/token
  1. Authenticate caller (or recognise guest)
  2. Load episode → must be PUBLISHED and its drama PUBLISHED
  3. Evaluate entitlement:
       accessType = FREE                     → allow
       active subscription                   → allow
       explicit EpisodeUnlock (coin/ad)      → allow
       otherwise                             → 403 EPISODE_LOCKED + unlock options
  4. Sign a Mux playback JWT (RS256, kid = Mux signing key id),
     aud=v, sub=playbackId, exp = now + max(episode duration × 2, 30 min)
  5. Return { playbackUrl, token, expiresAt, subtitles[], startPositionSec }
```

**Non-negotiables.** Every episode — free ones included — uses `playback_policy: signed`. A public playback ID is a permanent, un-revocable URL that anyone can scrape and rehost; signing costs nothing and removes that class of problem entirely. The Mux signing private key lives only in backend environment variables and is never shipped to any client (CLAUDE.md §12). Entitlement is evaluated at token-issue time, server-side, on every request — never trusted from the client (CLAUDE.md §11).

The `exp` window must comfortably exceed the episode's duration or playback will die mid-segment on a slow connection.

### Images

Posters, covers and thumbnails go to Cloudflare R2 behind a CDN, uploaded via backend-issued presigned PUT URLs with content-type and size limits enforced at issue time. Stored keys only — never raw public bucket URLs — so the delivery domain can change without a data migration.

---

## 8. Analytics & Observability

**Product analytics (two paths, deliberately):**

- **Firebase Analytics / GA4** for funnels and retention — screen views, signups, purchases.
- **Our own `PlaybackEvent` table** for anything the admin dashboard reports on. Views, watch duration and completion rate must be queryable by us, joinable with our catalogue, and correct. They cannot depend on an external product's sampling or retention window.

Clients batch a `playback_progress` heartbeat every 15 seconds alongside the lifecycle events. A nightly job rolls raw events into `EpisodeDailyStat`; the admin dashboard reads only the rollups. Raw events are dropped after 90 days — without that, this table becomes the largest object in the database within a quarter.

**Implemented in M2.4.** The 90-day sweep lives in
`modules/playback/playback.retention.ts` and runs as a manually invoked
command, `pnpm --filter @minidrama/backend retention:events` (with
`-- --dry-run` to count without deleting). It measures the window against
`receivedAt`, which Postgres sets, rather than the client-supplied
`occurredAt`; it deletes in bounded batches so no single transaction holds a
long lock; and it is idempotent, so a rerun is a no-op. A scheduler is
deliberately not part of this — see ADR-35. The `EpisodeDailyStat` rollup is
still scheduled work, so the admin dashboard has nothing to read yet.

Ingestion is rate limited at 120 requests per minute per caller (ADR-34),
sized so that a reconnecting device draining a real offline backlog cannot
trip it. A refusal is a 429 carrying `RATE_LIMITED`, which the mobile sync
adapter retries rather than treating as a rejection.

**The event taxonomy (M2.2, implemented M2.3).** Eight values, defined in `packages/contracts`:

`playback_started` · `playback_paused` · `playback_resumed` · `playback_progress` · `playback_completed` · `playback_failed` · `episode_changed` · `playback_abandoned`

> **Corrected in M2.3.** This document and DATABASE_SCHEMA.md §3 previously
> specified five SCREAMING_SNAKE values (`START`/`HEARTBEAT`/`PAUSE`/
> `COMPLETE`/`ERROR`). The shipped client produces eight, in lower_snake_case.
> They are an analytics vocabulary rather than a database enum — written to
> `PlaybackEvent.type`, aggregated into `EpisodeDailyStat`, and read in
> dashboards and ad-hoc SQL for the life of the product — so renaming them
> later means rewriting historical rows. See DECISIONS.md **ADR-26**.
>
> `playback_abandoned` is the one worth noting: without it a viewer who closes
> the player at 40% is indistinguishable from one still watching, and no
> drop-off curve is computable.

**Delivery is at-least-once (ADR-25).** The client retries any send whose
outcome it could not confirm, including sends that may have succeeded, so
ingestion must honour three rules:

1. **`eventId` is the idempotency key.** A repeat is a no-op, not a duplicate row.
2. **The acknowledgement names ids** (`acceptedEventIds`), not a bare 202. The client deletes only what the server says it stored; partial acceptance is a normal outcome.
3. **`occurredAt` is a device clock and is not trusted.** The server records its own `receivedAt` alongside it.

**Testing.** The playback pipeline and the backend are covered by Node's
built-in test runner rather than Jest — see DECISIONS.md **ADR-24** for the
trade-off and for when to add `jest-expo` (the first component test).

**Operational:** Sentry on all three apps with release tracking and sourcemap upload; structured JSON logs (pino) with a request ID propagated to Sentry; `/health` (liveness) and `/ready` (DB + Mux reachability). Mux Data gives playback QoE — rebuffer ratio, startup time, error rate — for free; it is what will tell us whether PLY-04 is actually being met in the field.

---

## 9. Key Architecture Decisions

Short-form ADRs. Full ADRs land in `docs/adr/` as each is approved.

| ID | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| ADR-01 | Modular monolith backend | Microservices, serverless functions | One team, one deploy unit. Module boundaries enforced by lint keep extraction cheap later. |
| ADR-02 | pnpm + Turborepo monorepo with `packages/contracts` | Three separate repos; npm workspaces | A shared, type-checked API contract is the cheapest defence against client/server drift. |
| ADR-03 | Firebase identity + backend-issued session JWT | Firebase tokens only; fully custom auth | Firebase solves OTP/Google cheaply; we must own roles, entitlement and revocation. |
| ADR-04 | Signed playback tokens for **all** episodes | Public playback for free content | A public playback ID is permanently scrapeable. Signing is free. |
| ADR-05 | pg-boss for background jobs | BullMQ + Redis; cron on the host | No new infrastructure; survives restarts; adequate at this scale. |
| ADR-06 | Own playback-event table alongside GA4 | GA4 only | Admin analytics must be joinable with the catalogue and under our retention control. |
| ADR-07 | Mux as video provider, behind a `VideoProvider` interface | Cloudflare Stream; self-hosted ffmpeg + S3 | Mux is the fastest path to a correct HLS pipeline. The interface exists because per-minute delivery cost is the single largest scaling risk (§10 R-2), and switching must not be a rewrite. |
| ADR-08 | Rule-based recommendations in v1 | Vector/collaborative filtering | No interaction data exists at launch. The endpoint contract is designed so the engine can be replaced invisibly. |
| ADR-23 | SQLite for the mobile offline outbox | AsyncStorage (as originally specified in §4) | A durable queue needs transactions, indexed dispatch and per-row retry metadata. **Supersedes the AsyncStorage note in §4.** |
| ADR-24 | Node's built-in test runner | Jest + jest-expo (CLAUDE.md §14) | Zero dependencies, and `node:sqlite` executes the repositories' real SQL. Revisit at the first component test. |
| ADR-25 | At-least-once delivery with server-side deduplication | Exactly-once; drop-on-ambiguity | Dropping a possibly-delivered event loses data on every lost response. Deduplication on `eventId` is cheap. |
| ADR-26 | lower_snake_case playback event names | SCREAMING_SNAKE, matching every other enum | These are analytics values that outlive the schema; renaming means rewriting history. **Supersedes the five-value enum in §8 and DATABASE_SCHEMA.md §3.** |

---

## 10. Technical Risks

| ID | Risk | Impact | Mitigation |
|---|---|---|---|
| **R-1** | **Vertical player feed performance.** Swipe-paged video on low-memory Android is where this product class usually fails: OOM kills, black frames on fast swipes, audio from the wrong episode. | Critical — this *is* the product | Three-instance player pool; prewarm next; hard release on unmount. **Dedicated spike in Milestone 1 on a real low-end device before any UI polish.** |
| **R-2** | **Video delivery cost.** Per-minute streaming cost scales linearly with watch time. At 50k MAU × 12 min/session this becomes the dominant line item, and it is invisible until the first large bill. | High — unit economics | Build the cost model as soon as PD-7 lands; `VideoProvider` abstraction (ADR-07); evaluate Cloudflare Stream at the first cost review; monitor delivered-minutes weekly from day one. |
| **R-3** | **Play Billing correctness.** Entitlement that disagrees with Play — refunds, grace periods, account holds, cross-device restores — produces both revenue loss and support load. | High | Play is the source of truth; RTDN via Pub/Sub drives all state changes; a nightly reconciliation job re-verifies active subscriptions; never grant entitlement from a client-reported purchase. |
| **R-4** | **IT Rules 2021 / DPDP non-compliance.** Age classification, grievance officer and redressal workflow are legal obligations for an Indian OTT publisher and are absent from the current requirements. | High — launch blocker | Treat as a Stage 1 requirement, not a Stage 8 one. Age rating in the schema from the first migration; grievance workflow scoped alongside content reports; legal review before Play submission. |
| **R-5** | ~~**Expo + pnpm monorepo friction.**~~ **Largely closed in M1.1.** | Medium → Low | Hoisted linking plus a monorepo `metro.config.js` works: a full Android bundle (1,227 modules) exports cleanly and `pnpm peers check` is clean. The npm-workspaces fallback is withdrawn. **Confirmed on a physical Android device via Expo Go (2026-11-15):** the app renders, Expo Router mounts, safe-area insets apply, and both `@minidrama/contracts` and `@minidrama/ui-tokens` resolve through Metro on-device. **Residual risk:** only the Expo Go path is exercised. A custom development build (`expo run:android`) is still untested and will be needed in M2 when `expo-video` — a native module Expo Go does not bundle — is added. |
| **R-6** | **Mux webhook reliability.** A dropped `asset.ready` leaves an episode stuck in PROCESSING forever. | Medium | Idempotent handlers keyed on event ID; a reconciliation job polls Mux for anything PROCESSING for more than 30 minutes; admin UI exposes a manual re-sync. |
| **R-7** | **Analytics table growth.** Heartbeats every 15s across a large audience is the highest-volume write path in the system. | Medium | Batch client-side; monthly partitions; nightly rollup; 90-day retention; the dashboard never queries raw events. |
| **R-8** | **Single Postgres instance is the whole availability story.** | Medium | Managed Postgres with PITR and automated backups; restore drill before launch — a backup nobody has restored is a hypothesis, not a backup. |
| **R-9** | **Content moderation at scale.** Report queue is manual in v1. | Low at launch | Acceptable for v1 volume. Revisit when reports exceed ~50/day. |

---

## 11. Environments & Deployment **[APPROVAL NEEDED — not covered in CLAUDE.md]**

CLAUDE.md specifies no hosting, CI or environment strategy. Proposal:

| Environment | Backend | Database | Mobile | Admin |
|---|---|---|---|---|
| Local | Docker Compose | Postgres in Docker | Expo Dev Client | Vite dev server |
| Staging | Managed container host | Managed Postgres (separate instance) | EAS internal distribution | Preview deploy |
| Production | Managed container host, ≥2 instances | Managed Postgres, PITR enabled | Play internal → closed → production track | Static host behind CDN |

**Recommended hosts:** Railway or Render for the API (simple, cheap, container-native, good enough to 10× the launch target), Neon or Supabase for Postgres (branching databases make migration testing genuinely safe), EAS Build + Submit for the app, Cloudflare Pages for admin. Everything here is portable — these are containers and Postgres, not proprietary runtimes.

**CI (GitHub Actions):** on every PR — typecheck, lint, unit tests, Prisma migration dry-run, affected-package builds via Turbo. On merge to `main` — deploy backend to staging, run migrations, run API integration tests against staging.

**Secrets:** never in the repo. Host-managed environment variables, with `.env.example` committed and `src/config/env.ts` parsing and validating every variable with Zod at boot. The process should refuse to start on a missing or malformed secret rather than fail at the first request.

---

## 12. Approval Status

| # | Item | Status |
|---|---|---|
| 1 | `apps/` + `packages/` monorepo layout, extending CLAUDE.md §4 (§3) | **Approved** 2026-11-15 · implemented M1.1 · DECISIONS.md ADR-01 |
| 2 | pnpm + Turborepo toolchain (§3) | **Approved** · implemented M1.1 · ADR-02 |
| 3 | `packages/contracts` as a shared Zod/type package (§3) | **Approved** · implemented M1.1 · ADR-05 |
| 4 | Firebase identity + backend-issued session JWT (§6) | **Superseded for M2.5 by ADR-37**: self-hosted email + password, implemented 2026-11-17. The backend-issued session half (ADR-07) is built as specified. Firebase remains approved in principle for Google/phone and is still deferred by CLAUDE.md §18. |
| 5 | pg-boss as a background job runner (§5) | **Approved**, installation deferred until first needed in M3 · ADR-08 |
| 6 | AdMob for rewarded ads, if MON-06 stays in scope (PRD PD-3) | **Open** — not needed before M7 |
| 7 | Hosting, CI and environment strategy (§11) | **Open** — CLAUDE.md §18 defers paid cloud hosting; local and free tiers only for now |
| 8 | IT Rules 2021 compliance as a Stage 1 concern (R-4) | **Open** — still recommended |

### Free-first policy (CLAUDE.md §18)

Added to CLAUDE.md after this document was written. It does not change the architecture, because the two integrations it most affects were already designed behind provider interfaces for other reasons:

| Concern | Development (free) | Production (needs approval) |
|---|---|---|
| Video (§7) | FFmpeg + locally generated HLS behind `VideoProvider` | Mux behind the same interface — ADR-09 |
| Identity (§6) | **Built:** self-hosted JWT + Argon2id behind `IdentityProvider` (ADR-37) | Firebase Auth for Google/phone — ADR-06 |
| Storage (§7) | Local filesystem behind `StorageProvider` | Cloudflare R2 |
| Database (§4) | Local PostgreSQL in Docker | Managed PostgreSQL |

The abstraction introduced to manage per-minute video cost (R-2) turns out to also satisfy the free-first policy. Nothing needs redesigning; the interfaces simply gain a second implementation each.
