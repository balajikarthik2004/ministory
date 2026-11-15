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

**Offline.** TanStack Query persistence for last-seen lists; watch-progress writes queue in AsyncStorage and flush on reconnect (HIST-06).

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

## 6. Authentication & Authorisation **[APPROVAL NEEDED]**

CLAUDE.md §3 offers "JWT or Firebase Authentication". These solve different halves of the problem, and the right answer uses both.

**Consumer (mobile):**

1. Firebase Authentication handles the identity proof — Google Sign-In and phone OTP. Building phone OTP ourselves means an SMS provider, DLT registration in India, retry logic and fraud handling, and buys nothing.
2. The client sends the Firebase ID token once to `POST /auth/session`.
3. The backend verifies it with the Firebase Admin SDK, upserts the `User`, and issues **its own** access token (JWT, 15 min) and refresh token (opaque, 60 days, rotating, hashed at rest).
4. Every subsequent call uses our access token.

Why not use the Firebase token directly: roles, subscription entitlement and ban status must be ours, evaluated server-side and revocable instantly. Firebase tokens cannot be revoked mid-flight and carry no entitlement claims we control. CLAUDE.md §11 — "never trust client-side subscription status" — is only satisfiable if the backend owns the token.

**Guest:** Firebase anonymous auth produces a real `User` row with `isAnonymous = true`. On sign-in, the anonymous account's history and favourites are merged into the permanent account inside one transaction (AUTH-06).

**Admin:** entirely separate. Email + password (argon2id), backend-issued JWT, mandatory TOTP 2FA for SuperAdmin, in a distinct token audience so a consumer token can never authenticate an admin route. Admin accounts are created by invitation only — no public signup path exists.

**Token storage:** `expo-secure-store` on mobile (Keychain/Keystore). Admin uses an httpOnly, Secure, SameSite=Strict refresh cookie; the access token stays in memory only. Never `localStorage`.

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

Clients send a playback heartbeat every 15 seconds plus `start` / `pause` / `complete` / `error` events, batched. A nightly job rolls raw events into `EpisodeDailyStat`; the admin dashboard reads only the rollups. Raw events are partitioned by month and dropped after 90 days — without that, this table becomes the largest object in the database within a quarter.

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
| 4 | Firebase identity + backend-issued session JWT (§6) | **Approved in principle**, deferred by CLAUDE.md §18 (free-first). Local JWT + bcrypt in development behind an `AuthProvider` interface. ADR-06 / ADR-07 |
| 5 | pg-boss as a background job runner (§5) | **Approved**, installation deferred until first needed in M3 · ADR-08 |
| 6 | AdMob for rewarded ads, if MON-06 stays in scope (PRD PD-3) | **Open** — not needed before M7 |
| 7 | Hosting, CI and environment strategy (§11) | **Open** — CLAUDE.md §18 defers paid cloud hosting; local and free tiers only for now |
| 8 | IT Rules 2021 compliance as a Stage 1 concern (R-4) | **Open** — still recommended |

### Free-first policy (CLAUDE.md §18)

Added to CLAUDE.md after this document was written. It does not change the architecture, because the two integrations it most affects were already designed behind provider interfaces for other reasons:

| Concern | Development (free) | Production (needs approval) |
|---|---|---|
| Video (§7) | FFmpeg + locally generated HLS behind `VideoProvider` | Mux behind the same interface — ADR-09 |
| Identity (§6) | Local JWT + bcrypt behind `AuthProvider` | Firebase Auth — ADR-06 |
| Storage (§7) | Local filesystem behind `StorageProvider` | Cloudflare R2 |
| Database (§4) | Local PostgreSQL in Docker | Managed PostgreSQL |

The abstraction introduced to manage per-minute video cost (R-2) turns out to also satisfy the free-first policy. Nothing needs redesigning; the interfaces simply gain a second implementation each.
