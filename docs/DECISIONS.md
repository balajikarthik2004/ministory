# MiniDrama — Architecture Decision Record

**Status:** ADR-01 … ADR-10 approved 2026-11-15. ADR-11 … ADR-16 are implementation decisions made during Milestone 1.1, ADR-17 … ADR-18 during Milestone 1.3. All are open to revision.
**Last updated:** 2026-11-15

Each record states the decision, what else was considered, and what it costs us. A decision with no stated cost has not been thought through.

---

## ADR-01 — `apps/` + `packages/` monorepo structure

**Status:** Approved · **Supersedes:** CLAUDE.md §4 directory layout

Three applications live under `apps/`; shared code lives under `packages/`. The internal structure of each app is exactly as CLAUDE.md §4 specifies.

**Alternatives**

| Option | Why not |
|---|---|
| Three separate repositories | Every API change becomes a cross-repo PR dance. Versioning the contract between three repos costs more than it protects. |
| CLAUDE.md §4 flat layout, no `packages/` | No home for shared code. The API contract gets hand-copied into three places and drifts — the failure shows up as a mobile release breaking on a backend field rename nobody type-checked. |

**Trade-offs.** One `pnpm install` now touches all three apps, so a dependency problem in one can block the others. Tooling must understand workspaces. Against that: one PR can change the backend and both clients atomically, and `packages/contracts` makes drift a compile error.

**Rule.** `apps/*` may depend on `packages/*`. `packages/*` never depend on `apps/*`. No app imports another app. This preserves the CLAUDE.md §4 requirement that the three stay independently maintainable.

---

## ADR-02 — pnpm workspaces with hoisted linking, plus Turborepo

**Status:** Approved · **Verified:** Milestone 1.1

`nodeLinker: hoisted` in `pnpm-workspace.yaml` and `node-linker=hoisted` in `.npmrc`.

**Alternatives**

| Option | Why not |
|---|---|
| npm workspaces | Slower installs, no content-addressed store. Held in reserve as the fallback if pnpm fought Metro — it did not. |
| Yarn Berry PnP | Metro does not support PnP resolution. A non-starter for Expo. |
| pnpm default (symlinked) | Metro cannot reliably follow pnpm's symlinked store. This is the documented reason Expo recommends hoisting. |
| Nx instead of Turborepo | More capable, much more configuration. Turborepo's caching is the only part we need today. |

**Trade-offs.** Hoisting gives up pnpm's strictness: a package can import something it never declared and it will resolve anyway, so an undeclared dependency survives until it breaks somewhere else. We accept that because Metro's resolution is not negotiable. Mitigation: `pnpm peers check` runs clean today, and should stay in CI.

**Verified in M1.1.** Install, typecheck, lint, admin production build and a full Android Metro bundle (1,227 modules) all succeed. Risk R-5 in SYSTEM_ARCHITECTURE.md is closed for the bundler; closing it for a device still requires a device run.

---

## ADR-03 — Modular monolith backend

**Status:** Approved

One deployable Express service. Each of the 17 CLAUDE.md §7 modules is a self-contained folder: routes, controller, service, repository, schema.

**Alternatives**

| Option | Why not |
|---|---|
| Microservices | One team, pre-launch. Buys distributed tracing, network failure modes and deployment choreography, and returns nothing at this scale. |
| Serverless functions | Cold starts on the playback-authorisation path are exactly where latency hurts most. Connection pooling against Postgres also becomes a problem to solve rather than a default. |

**Trade-offs.** One process means one blast radius and one scaling unit. Accepted because module boundaries are enforced in the linter (`no-restricted-imports` blocks importing another module's repository), which keeps a later extraction a move rather than a rewrite. Analytics ingestion is the module most likely to leave first.

---

## ADR-04 — PostgreSQL + Prisma

**Status:** Approved

**Alternatives**

| Option | Why not |
|---|---|
| MongoDB | The domain is relational throughout — drama → season → episode, entitlements, payments. Transactions across those are routine, not exotic. |
| Drizzle / Kysely | Lighter and closer to SQL, but Prisma Migrate's workflow and the generated client are worth more to a small team than the abstraction cost. |

**Trade-offs.** Prisma's query builder makes some joins awkward and can generate more queries than hand-written SQL. Mitigated by confining all Prisma calls to a repository layer, so query shape and index usage are reviewable in one file per module. Raw SQL stays available where the ORM gets in the way.

**Free-first (CLAUDE.md §18).** Local PostgreSQL in Docker for development. No managed database is provisioned until production hosting is approved.

---

## ADR-05 — Shared Zod contracts in `packages/contracts`

**Status:** Approved · **Implemented:** Milestone 1.1 (envelope, error codes, health)

One Zod schema per API shape. The backend validates with it, both clients parse with it, OpenAPI is generated from it.

**Alternatives**

| Option | Why not |
|---|---|
| OpenAPI spec first, generate types | A separate artefact that must be kept in sync by hand or by a generator step. Zod gives runtime validation and static types from one definition. |
| tRPC | Excellent end-to-end types, but it is not REST. CLAUDE.md §3 specifies REST APIs, and a public REST surface is easier for a future web client or partner. |
| Hand-written types per app | The drift this ADR exists to prevent. |

**Trade-offs.** Every client is coupled to one version of the contract package, so a breaking schema change is felt immediately — which is the point, but it does mean the mobile app must be rebuilt to pick up a contract change. Zod also adds ~14KB to the mobile bundle.

Directly serves CLAUDE.md §16.13 ("do not invent API responses or database fields"): with a shared contract, inventing a field is a type error.

---

## ADR-06 — Firebase Authentication for identity verification

**Status:** Approved in principle · **Deferred by CLAUDE.md §18** · **Not implemented in M1.1**

Firebase proves *who the user is* — Google Sign-In and phone OTP. Nothing more.

**Alternatives**

| Option | Why not |
|---|---|
| Build phone OTP ourselves | An SMS provider, DLT registration in India, retry and fraud handling. Weeks of work for a solved problem. |
| Auth0 / Clerk | Per-MAU pricing that scales badly for a consumer app, and more lock-in than Firebase for the same job. |
| Local JWT + bcrypt only | Correct for development (and is what §18 mandates), but gives no Google or phone sign-in for production. |

**Trade-offs and the §18 conflict.** Firebase phone OTP requires the paid Blaze plan, which CLAUDE.md §18 defers. Resolution:

- **Development:** local JWT + bcrypt behind an `AuthProvider` interface, per §18.
- **Production:** Firebase, swapped in behind the same interface, when the cost is approved.
- The backend's session and authorisation layer (ADR-07) is identical either way, so this is a provider swap and not a rewrite.

Requires explicit approval before any Firebase billing is enabled.

---

## ADR-07 — The backend owns authorization, sessions and entitlements

**Status:** Approved

Whatever proves identity, the backend issues its own short-lived access token (15 min) plus a rotating refresh token, and every authorisation decision is made server-side from the database.

**Alternatives**

| Option | Why not |
|---|---|
| Use the Firebase ID token directly as the API credential | Firebase tokens carry no entitlement claims we control and cannot be revoked mid-flight. A banned user would keep working until their token expired. |
| Entitlement claims baked into the JWT | A subscription can lapse, be refunded or be put on hold inside a token's lifetime. A stale claim is a free premium episode. |

**Trade-offs.** An entitlement check per playback-token request means a database read on the hottest path. That is the cost of being correct, and it is one indexed lookup (`Subscription(status, expiresAt)`).

This is what makes CLAUDE.md §11 — "never trust client-side subscription status" — actually true rather than aspirational.

---

## ADR-08 — pg-boss for background jobs, installed when first needed

**Status:** Approved, deferred · **Not installed in M1.1**

**Alternatives**

| Option | Why not |
|---|---|
| BullMQ + Redis | More capable, but adds an infrastructure component for a queue we can run in the database we already have. Revisit if Redis arrives for caching. |
| Host cron | No retries, no visibility, no idempotency. Fine for one nightly job, not for webhook retries and notification fan-out. |
| `setInterval` in the API process | Silently runs N times on N instances. |

**Trade-offs.** A Postgres-backed queue competes for the same connections and I/O as the application. Acceptable at this scale; the volume that breaks it is far beyond the launch target.

First needed in M3 (scheduled publication, notification fan-out). Installing it in M1.1 would be a dependency with nothing to run.

---

## ADR-09 — Mux behind a `VideoProvider` interface

**Status:** Approved in principle · **Deferred by CLAUDE.md §18** · **Not implemented in M1.1**

All video operations — create upload, read asset status, sign playback — go through one interface. No Mux type appears outside its implementation.

**Alternatives**

| Option | Why not |
|---|---|
| Mux SDK called directly from services | Per-minute delivery cost is the largest scaling risk in the product (SYSTEM_ARCHITECTURE.md R-2). Direct calls make switching a rewrite. |
| Self-hosted FFmpeg + S3 + HLS for production | Far cheaper per minute, far more operational work: transcoding queue, renditions, packaging, CDN, signing. A reasonable *destination*, a poor *starting point*. |
| Cloudflare Stream | A credible alternative on price. The interface is what keeps that comparison cheap to act on later. |

**Trade-offs.** The interface is a thin abstraction over something with provider-specific concepts (playback IDs, signing keys, webhook shapes), so it will leak a little. Worth it.

**Free-first (§18).** Development uses FFmpeg and locally generated HLS behind the same interface. Mux is not integrated until paid usage is approved. The interface was designed for a cost risk and turns out to also satisfy the free-first policy — the same abstraction serves both.

---

## ADR-10 — Free content and subscriptions first; coins stay extensible

**Status:** Approved

v1 ships free episodes plus a subscription. The coin wallet and per-episode unlock are designed into the schema now and implemented later.

**Alternatives**

| Option | Why not |
|---|---|
| Coins first | More complex: wallet, idempotent spend, ad-reward verification, coin-pack purchases. Slower to a shippable product. |
| Subscription only, coins never | Per-episode unlock is what actually converts in this category. Designing it out now means a painful migration later. |
| Both at once | More monetisation surface than can be tested properly in one milestone. |

**Trade-offs.** `CoinWallet`, `CoinTransaction` and `EpisodeUnlock` exist in the schema before anything writes to them — tables that look like dead weight for several milestones. That is cheaper than adding a wallet to a system with live payment data.

Entitlement is evaluated through one function from the start, so adding a `COIN` unlock source is a new branch, not a new concept.

---

## Implementation decisions from Milestone 1.1

These were made while building the foundation. They are smaller, and more open to revision, than ADR-01…10.

### ADR-11 — TypeScript 6.0.3 across the workspace

The intent was TypeScript 5.9.3. Two constraints disagreed with it:

- `typescript-eslint@8.72.2` supports `typescript >=4.8.4 <6.1.0` — **TypeScript 7 is not supported**, so the current `latest` (7.0.2) would have broken linting entirely.
- Expo SDK 58 expects `typescript ~6.0.3`, reported by `expo install --check`.

6.0.3 is the only version that satisfies both. Verified: all six packages typecheck and lint clean on it.

Revisit when typescript-eslint supports TypeScript 7.

### ADR-12 — React pinned to 19.3.0 by a workspace override

`react` and `react-dom` are pinned to 19.3.0 in `pnpm-workspace.yaml` `overrides`.

Expo SDK 58 expects 19.3.0; `react-dom@19.3.1` arrived transitively as an optional peer of `expo-router` and wanted `react@^19.3.1`. In a hoisted layout that is how a second copy of React ends up in the tree, and a second React is the classic cause of "invalid hook call" — a confusing runtime failure, not a resolution error. The override makes it impossible. `pnpm peers check` is clean.

### ADR-13 — ESLint 10 flat config, type-aware linting deferred

ESLint 10.15.0 with flat config. `typescript-eslint`, `eslint-plugin-react-hooks` and `eslint-plugin-react-refresh` all support it; `eslint-plugin-import` does not, and is not needed — module-boundary enforcement uses the core `no-restricted-imports` rule, which needs no type information.

Type-aware linting is deliberately off. It needs a tsconfig project per package and roughly triples lint time. Reconsider in M1.4 once CI timings are real.

### ADR-14 — Shared TypeScript base at the repository root

`tsconfig.base.json` sits at the root and every package extends it by relative path. Putting the base inside `packages/config` and resolving it by package name works, but adds a resolution step that fails confusingly when it fails. A relative path always resolves.

`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns` and `noFallthroughCasesInSwitch` are on. `noUnusedLocals`/`noUnusedParameters` are off in tsc and handled by ESLint instead, so an unused variable during development is a lint warning rather than a failed build.

### ADR-15 — `packages/contracts` and `packages/ui-tokens` are compiled, not source-only

Both build to `dist/` with `tsc` and are consumed through `exports`. The alternative — Turborepo's "just-in-time" pattern, where a package points `main` at its TypeScript source — removes a build step but breaks `tsc` emit for the backend, because importing TypeScript from outside `rootDir` has nowhere to emit to.

Cost: Turbo must build packages before apps typecheck, which `dependsOn: ["^build"]` handles. Benefit: one pattern for both packages, and `node dist/server.js` runs without a bundler.

### ADR-16 — No router in the admin app yet

`react-router-dom` is in the approved stack (CLAUDE.md §3) but is not installed. Milestone 1.1 forbids user-facing features, and a router with one placeholder route is configuration with nothing to configure. It lands in M5 with the admin shell.

---

## Implementation decisions from Milestone 1.3

### ADR-17 — Prisma 7 with the `@prisma/adapter-pg` driver adapter

**Status:** Implemented in M1.3 · **Refines:** ADR-04

Prisma 7 removed `url` from the `datasource` block. A connection string now
reaches the CLI through `prisma.config.ts` and the client through a driver
adapter passed to the constructor. Using Prisma 7 therefore means adding
`@prisma/adapter-pg`, which carries `pg` as its own dependency.

| Option | Why not |
|---|---|
| Pin Prisma 6.19.3 | The previous major still supports `url` in the schema and needs no adapter. But it starts a brand-new project one major version behind, and the upgrade would land mid-M3 with live schema history instead of now with one migration. |
| `prisma@8.0.0-rc` | It currently holds the `latest` dist-tag on npm. It is a release candidate, and the database layer of a product is not where to find out what changed in a major version. |

**Consequences.** One dependency added for a genuine requirement, not a
preference. The pool is now configured explicitly in application code
(`DATABASE_POOL_MAX`, idle and connection timeouts) rather than inside an
opaque engine — visible and tunable, but also now our responsibility.

**Trade-off accepted.** The Prisma 7 adapter path has less written about it
than the 6.x setup, so the next person hitting an error may find fewer answers.
`prisma.config.ts` and `src/services/prisma.ts` both carry comments explaining
why they are shaped the way they are.

---

### ADR-18 — Migration 1 covers the MVP core, not the whole schema document

**Status:** Implemented in M1.3 · **Deviates from:** ADR-10

DATABASE_SCHEMA.md §3 specifies 28 models. Migration 1 creates 13: identity,
catalogue and engagement. Monetisation, auth sessions, admin identity,
notifications, moderation and analytics are scheduled against the milestones
that use them (DATABASE_SCHEMA.md §9.2).

| Option | Why not |
|---|---|
| Create all 28 now | Fifteen tables that nothing reads or writes for several milestones, each one a schema guess made before the feature that will use it exists. |
| Create only what M2 reads | Even less — but `Season`, `Subtitle` and `DramaTranslation` are cheap, settled by the PRD, and awkward to retrofit into a catalogue that already has rows. |

**The deviation from ADR-10, stated plainly.** ADR-10 says `CoinWallet`,
`CoinTransaction` and `EpisodeUnlock` should exist from migration 1. They do
not. Its reasoning was that adding a wallet to a system with live payment data
is painful — true, and there will be no payment data until M7, so the additive
migration stays cheap until then. `Episode.coinPrice` is present now, because
per-episode pricing is the part that would have to be retrofitted onto a live
catalogue.

**Revisit if** monetisation work starts before M7, or if a migration to add
these tables turns out to need a backfill rather than being purely additive.

---

## Implementation decisions from Milestone 2.1

### ADR-19 — Zustand, TanStack Query and `@expo/vector-icons` added; Reanimated deferred

M2.1 added exactly three runtime dependencies to `apps/mobile`:

| Package | Version | Why |
|---|---|---|
| `zustand` | 5.1.0 | Named in CLAUDE.md §3. Holds the viewer's library (favourites, watch progress) where writes are frequent and must be optimistic. |
| `@tanstack/react-query` | 5.107.1 | Named in CLAUDE.md §3. Owns every server read: caching, retry/backoff, loading and error state. |
| `@expo/vector-icons` | 15.1.1 | Not named anywhere, and the one genuine addition. Expo-maintained, bundled in Expo Go, free. Without an icon set the tab bar, player transport and every action control would be drawn by hand. |

**Reanimated was deliberately NOT added**, despite CLAUDE.md §3 listing it and
UI_UX_GUIDELINES.md §1 saying "all animation runs on the Reanimated UI thread".
Every animation M2.1 needs — press feedback, splash fade, skeleton pulse — is
an opacity or transform, which React Native's own `Animated` already drives on
the UI thread via `useNativeDriver`. The JS thread is untouched either way.
Reanimated earns its place when the app needs gesture-driven or layout
animation; adding a native module before then is cost without benefit, and the
M2.1 brief asks for no unnecessary dependencies.

**`expo-linear-gradient` was also not added.** `overlay.gradient` is a real
token and the banner, detail hero and player overlay all need a scrim. They
use `components/primitives/Gradient.tsx`, which stacks background-coloured
bands at eased opacities — visually indistinguishable from an interpolated
gradient on `#090A0F`, and swappable from one file if the project later
decides the dependency is worth it. Poster and thumbnail scrims are baked into
the generated artwork instead, so no list cell pays for a band stack.

**Revisit if** a gesture-driven interaction (swipe-to-dismiss the player,
drag-to-scrub) is specified, or if the band-stack scrim shows banding on a
real panel — either would justify Reanimated and `expo-linear-gradient`
respectively.

### ADR-20 — Mock data behind the contract, not behind the components

`apps/mobile/services/mock-api.ts` is the single boundary between the UI and
"the server". Its function signatures are the endpoint shapes from
API_DOCUMENTATION.md §4–§6 and its return types come from
`@minidrama/contracts`, not from the mock dataset. Every screen reaches data
through a TanStack Query hook in `services/catalogue.queries.ts`; no component
imports the mock dataset.

The alternative — components holding literal arrays — would have been faster
and would have made M3 a rewrite of every screen rather than a replacement of
one module.

Two consequences worth stating:

- **The mock is validated against the contract at module load.** Every record
  in `data/catalogue.mock.ts` is `parse`d, not cast. A mock that drifts from
  the contract fails immediately instead of shaping a screen the real API will
  not fit. `tools/verify-mock-catalogue.mjs` runs the same parses in Node so
  the failure is caught in a second rather than as a crash on a device.
- **The mock enforces entitlement.** `requestPlaybackTicket` refuses a locked
  episode with `EPISODE_LOCKED` rather than returning a flag the player could
  ignore, and the player renders the unlock panel from that refusal. The
  control flow is the one M4 will have when the backend evaluates entitlement
  against the database (CLAUDE.md §11).

This also extended `packages/contracts` with the catalogue, library and
playback schemas — the half of M1.5 that M2.1 could not proceed without.

### ADR-21 — The player sits behind a `VideoPlayerController` interface

`features/player/types.ts` defines the contract; `useSinglePlayerController`
implements Strategy A from VIDEO_PLAYER_SPIKE.md §10 (one player, source
replaced on each swipe).

This is not speculative abstraction. The spike's own recommendation ends with
a caveat: B and C were never measured on an unconstrained path, and the
finding "should be re-tested before it hardens into architecture". A pooled or
dual-player controller implementing the same interface would drop in without
the player screen changing.

### ADR-22 — Placeholder artwork is generated, not sourced

`tools/placeholder-art/generate.mjs` emits 24 PNGs (poster, banner and
thumbnail per drama) as original abstract gradient compositions, using a
hand-rolled PNG encoder over Node's built-in `zlib`. No dependency, no image
service, no asset taken from a reference app (CLAUDE.md §16.16, §18).

Deterministic by design: seeded per `slug:variant`, so a re-run is
byte-identical and regenerating does not churn the diff. Output is 3.0 MB for
24 images; the first version was 7 MB until the encoder learned adaptive
per-scanline filtering and the per-pixel grain was replaced by a 4x4 block
field plus an ordered Bayer dither.

**These are honest placeholders, not key art.** Replace them with licensed
artwork before any release.

---

## Implementation decisions from Milestone 2.2

### ADR-23 — SQLite for the local outbox, not AsyncStorage

SYSTEM_ARCHITECTURE.md §4 says "watch-progress writes queue in AsyncStorage
and flush on reconnect (HIST-06)". M2.2 uses `expo-sqlite` instead. **That
document should be updated**; this ADR records why.

AsyncStorage is a key-value store with no transactions and no query language.
A durable outbox needs both:

- **Claim-and-update must be atomic.** The sync engine selects due rows and
  marks them in flight in one step. On AsyncStorage that is read-modify-write
  on a single JSON blob, and two writers — the player flushing progress while
  the engine drains — can lose each other's changes entirely.
- **The dispatch query is a query.** "Pending rows whose backoff has elapsed,
  oldest first, limit 25" is one indexed statement in SQLite. On AsyncStorage
  it means deserialising the whole queue on every tick.
- **Per-row metadata.** Attempt counts, next-attempt times and last errors
  belong on the row. Keeping them in a parallel blob is a second source of
  truth for the same fact.

The cost is a dependency (`expo-sqlite`, in the Expo SDK, free) and a
migration path. Both are cheap; losing a viewer's watch history to a lost
update is not.

SQLite here is **mobile-local only**. It is not a copy of the server schema
and must not become one: it holds the outbox and the viewer's own progress,
and nothing else. PostgreSQL remains the system of record.

### ADR-24 — Node's built-in test runner, not Jest

CLAUDE.md §14 says "Use Jest and appropriate React Native testing tools". M2.2
uses `node --test` with `node:sqlite`. The trade-off, stated plainly so it can
be overridden:

**Why not Jest.** `jest-expo` plus `@testing-library/react-native` is three
dependencies and a transform pipeline. Every test M2.2 needs — event creation,
queue insertion, duplicates, retry, failed sync, successful sync, the
offline→online transition, restart recovery — is non-UI logic. None of it
renders a component.

**What Node's runner buys.** Zero dependencies, and `node:sqlite` means the
repositories' statements run against a **real SQLite engine**. `ON CONFLICT DO
NOTHING`, the backoff gate, the monotonic progress rule and `PRAGMA
user_version` migrations are all executed, not simulated. A hand-written fake
would have agreed with whatever the implementation did and passed while the
SQL was wrong.

**When to revisit.** The first component test. `node --test` cannot render
React Native, so a test for the offline banner or the sync panel needs
`jest-expo`. Adding it then is additive — these tests keep running unchanged —
and it should be added the day it is actually needed, not before.

This also required splitting `playback-service.ts`: the pure composition root
has no React Native imports, and the device wiring lives in
`device-service.ts`. That split was forced by the tests and is an improvement
regardless — a composition root that can only be constructed on a device is
one that can only be verified on a device.

### ADR-25 — At-least-once delivery, with server-side deduplication

The outbox retries any send whose outcome is not a confirmed acceptance,
including sends that may have succeeded. The alternative — dropping anything
possibly-delivered — loses data whenever a response is lost in transit, which
on a mobile network is routine.

Three consequences the server must honour in M2.3:

1. **`eventId` is the idempotency key.** Ingestion must treat a repeat as a
   no-op, not a duplicate row.
2. **The acknowledgement names ids.** `playbackEventAckSchema` returns
   `acceptedEventIds` rather than a bare 202, because the client must not
   delete anything it cannot prove was stored. Partial acceptance is a normal
   outcome.
3. **Device clocks are not trusted.** `occurredAt` comes from the device and
   can be wrong or deliberately altered; the server records its own receipt
   time alongside it.

Events that exhaust their eight attempts become `dead` rather than being
deleted. A deleted row is indistinguishable from a delivered one; a dead row
can be counted, shown to the viewer and investigated.

### ADR-26 — Playback event names are lower_snake_case

Every other enum in the project is SCREAMING_SNAKE. The eight playback event
types are not, deliberately: they are an analytics taxonomy rather than a
database enum. They will be written to `PlaybackEvent.type`, rolled into
`EpisodeDailyStat`, and read in dashboards and ad-hoc SQL for the life of the
product. Renaming them later means rewriting historical rows, so the
convention is fixed now and documented here rather than being discovered as an
inconsistency later.

`API_DOCUMENTATION.md` §5 has been updated to match; the previous five-value
`START`/`HEARTBEAT`/`PAUSE`/`COMPLETE`/`ERROR` set no longer exists.

---

## Implementation decisions from Milestone 2.3

### ADR-27 — The development identity provider, and its four guards

Real authentication is M2.5. Until then protected routes need *some* caller,
and the development provider maps a shared token to the seeded user. It
verifies nothing cryptographically, so the interesting part is how it is kept
off a production machine:

1. `DEV_AUTH_ENABLED` must be explicitly `true`; the default is off.
2. The process **refuses to start** if that flag is true with
   `NODE_ENV=production` (`config/env.ts`), rather than quietly disabling it.
   A silently-disabled auth provider is the worse failure: every request
   becomes anonymous, the library endpoints return empty, and it looks like a
   data problem for a day.
3. The provider's constructor throws if built in production
   (`services/identity.ts`), so a future refactor of the config cannot remove
   the check by accident.
4. An empty `DEV_AUTH_TOKEN` leaves the `NullIdentityProvider` in place, which
   resolves nobody and returns 401 everywhere — failing closed.

Guards 2 and 3 are verified by tests that spawn a child process with
`NODE_ENV=production`, because "the production guard works" is exactly the
claim that must not be taken on trust.

**The ownership rule is structural, not a check.** Services take a `userId`
parameter; no service reads a request. `PlaybackEvent.userId` comes from the
resolved caller, and the event contract has no `userId` field at all, so there
is nothing to spoof. A `dramaId` in a progress or event payload is checked
against the episode's real owner and corrected rather than trusted.

M2.5 replaces one branch in `bootstrap/identity.ts`.

### ADR-28 — Playback events: the client's UUID is the primary key

`PlaybackEvent.eventId` is the primary key rather than an autoincrement
`BigInt` as DATABASE_SCHEMA.md §3 specified. Delivery is at-least-once
(ADR-25), so ingestion must be idempotent; making the client's id the primary
key turns that into a constraint the database enforces via
`createMany({ skipDuplicates: true })`, instead of a read-then-write with a
race between the two statements.

`occurredAt` (device) and `receivedAt` (server, defaulted by Postgres rather
than by Node so it is consistent across instances) are stored separately. A
device clock can be wrong, unset or deliberately altered; an analytics table
holding only the client's timestamp cannot be trusted to order anything.

**Partial acceptance is the contract.** The response names
`acceptedEventIds`. A batch with one malformed event stores the rest — failing
the whole batch would strand good events behind a bad one, retried until they
died. Rejected events are logged and never echoed back, because echoing a
rejected payload is a reflected leak.

### ADR-29 — The mobile API is an adapter, and mock mode stays

`services/api/index.ts` exposes one `CatalogueApi` interface with two
implementations, chosen by `EXPO_PUBLIC_API_MODE`. The query layer imports
that module and nothing else; no screen or hook branches on the mode.

Mock mode is **not** dead code. UI work without Docker, a screen whose
endpoint does not exist yet, and failure states that would otherwise need a
server to be stopped all depend on it. The brief for M2.1 built those states;
removing the only way to reproduce them would waste that.

`requestPlaybackTicket` is the one function still assembled client-side in
live mode. `POST /playback/episodes/:id/token` is M4 — it needs the signing
key and entitlement evaluation that arrive with the real video provider, and
CLAUDE.md §16.13 forbids inventing an endpoint. The lock is still enforced
from the server's own `isLocked`, so the client applies a decision rather than
making one.

### ADR-30 — Backend tests use a separate database, after a schema-based attempt destroyed data

The test suite truncates tables between cases, so isolation is not optional.

**The first implementation was wrong and cost the development database.** It
appended `?schema=minidrama_test` to the connection string — which is how
Prisma isolates when it drives Postgres through its own query engine. This
project uses the **driver adapter** (`@prisma/adapter-pg`, ADR-17), and the
adapter hands the connection string to `pg`, which does not understand
`?schema=`. Every "isolated" statement ran against `public`. The first full
suite run emptied the seeded catalogue; it was restored by re-running the
deterministic seed, which is the second time that determinism has paid for
itself.

The fix is a separate **database** (`minidrama_test`), created on demand and
migrated with `migrate deploy`. There is no parameter left to be silently
ignored. Two guards were added because the failure was silent:

- A static check that refuses any connection string whose database is not
  exactly `minidrama_test`.
- A runtime check that asks Postgres `SELECT current_database()` *after*
  connecting and refuses to proceed on a mismatch. That is the one that would
  have caught the original bug on its first run rather than afterwards.

**The lesson worth keeping:** when a safety mechanism is a string in a URL,
verify it against the system that is supposed to honour it. The URL looked
isolated; the connection was not.

Test files run with `--test-concurrency=1`, since they share one database.

---

## Known deviation to resolve

**Admin Tailwind theme duplicates the token values.** `apps/admin/src/index.css` hand-mirrors the hex values from `@minidrama/ui-tokens` into a Tailwind v4 `@theme` block, because CSS cannot import a TypeScript module. Two sources of truth for the same colours is exactly the drift `packages/ui-tokens` exists to prevent.

Resolution in M2: a small generator in `ui-tokens` emits a CSS custom-property file that the admin imports. Marked with a comment in the CSS and tracked in DEVELOPMENT_ROADMAP.md §3.

~~**SYSTEM_ARCHITECTURE.md §4 still names AsyncStorage for the offline
queue.**~~ **Resolved in M2.3.** §4 now specifies SQLite and carries a
"Corrected in M2.2" note pointing at ADR-23. §8 and DATABASE_SCHEMA.md §3 were
corrected at the same time for the event taxonomy (ADR-26).

---

# M2.4 — Reliability and backend hardening

### ADR-31 — One resume rule, resolved from server watch state

Home's Continue Watching rail read server progress while the drama detail
page's "Resume Episode N" read the device's SQLite copy. Nothing reconciled
the two, so the same drama offered different episodes depending on which
screen you tapped — observed on device as Home saying EP 3 and detail saying
EP 2.

**Decision.** `apps/mobile/services/resume.ts` holds the single rule, and it
resolves from the `watchState` the server attaches to every episode it
returns. Both screens call it. The device's SQLite copy remains the
write-ahead record and the offline fallback — it is what the app writes
first and what survives a crash — but it is no longer a second source of
truth for *display*.

The rule mirrors the server's `library.repository.resumeTargets`: resume the
furthest episode reached, and if that episode is finished, resume the next
one. Keeping the two deliberately in step is what stops the rail and the CTA
drifting apart again; `tests/resume.test.ts` and
`tests/continue-watching.test.ts` assert the same behaviour on each side.

**Offline is preserved,** because the episode list is served from the
TanStack Query cache when the network is gone. The resolver reads whatever
state that cache holds rather than falling back to a different store.

### ADR-32 — Progress durability is a dirty flag, not a queue

Progress was written to SQLite and pushed to the server fire-and-forget.
The local write was durable; the push was retried by nothing. A position
recorded as a connection dropped stayed on the device and never reached the
server.

**Rejected: putting progress in the event outbox.** Events are append-only
analytics where every row matters. Progress is last-write-wins state: only
the newest position per episode is worth sending. Queueing every five-second
tick would fill the outbox with writes obsolete before delivery, and couple
two things with different retry semantics.

**Decision.** `watch_progress.pending_sync` (local schema version 2). The
write sets it, a server acknowledgement clears it, and startup, foreground
and reconnect replay whatever is still dirty.

The property that makes this the smallest correct design: **one row per
episode already holds the latest position**, so a backlog is bounded by
episodes watched rather than by ticks elapsed. A device offline for a week
sends one write per episode, not thousands.

`markSynced` is guarded on `updated_at`. A position written while a request
was in flight must not be marked delivered — it stays dirty and flushes on
the next pass. Replay is safe because position is monotonic and completion
sticky on both sides, so an out-of-order flush cannot rewind a viewer.

### ADR-33 — A completed drama leaves Continue Watching; a finished episode advances

`DramaProgress.isCompleted` was created `false` and never updated, so no
drama ever left the rail. Separately, the rail offered the episode last
*watched* rather than the one to watch *next*, which showed a finished
episode at "0s left" indefinitely.

**Decision, in two parts.**

*Write path.* Completing an episode checks for a later published episode in
the drama. If there is none, the drama is marked complete and the repository
query drops it from the rail.

*Read path.* `resumeTargets` resolves a finished head to its successor, so
the rail offers what to play next, at position zero.

**Completion is recomputed, not sticky.** Publishing episode 11 of a drama a
viewer had finished must put it back in Continue Watching; a sticky flag
would strand them. This is asserted directly.

Watch history is untouched by either part — a drama leaving the rail is a
change to what is offered, not to what was recorded.

### ADR-34 — Rate limiting is in-process, and says so

`POST /playback/events` is the only endpoint a client calls unprompted and
in a loop, so it is the only one rate limited.

**No new dependency.** `express-rate-limit` would be a dependency to
re-implement thirty lines, against CLAUDE.md §16.15, and the free-first
policy rules out Redis for the MVP.

**The limitation, stated rather than hidden:** the counter is per process.
Two instances behind a load balancer double the effective limit. That is
fine while the deployment is one container and wrong the moment it is not,
so `RateLimiter` sits behind a narrow interface — moving to a shared store
means replacing `hit()`, not touching a route.

**Sized so honest traffic cannot trip it.** 120 requests per minute per
caller, against batches of up to 100 events, is 12,000 events per minute
from one viewer; an hour of continuous playback generates roughly 240
heartbeats. A test drives 240 events through in twelve batches to prove a
real offline backlog passes cleanly.

**The refusal is a 429 carrying `RATE_LIMITED`,** which matters more than it
looks: `HttpPlaybackSyncAdapter` classifies 429 as a transport failure and
retries, where any other 4xx marks the batch dead. A throttled batch is
delayed, never discarded.

Authenticated callers are keyed by user id. Everyone else falls back to IP,
which API_DOCUMENTATION.md §9 already flags as unreliable on shared-NAT
mobile networks in India — the generous limit mitigates it; a device-bound
guest token in M2.5 is the real fix.

### ADR-35 — Retention is a command, measured on `receivedAt`

SYSTEM_ARCHITECTURE.md §8 and DATABASE_SCHEMA.md §6 specify 90 days for
`PlaybackEvent`; risk R-7 explains why it is not optional.

**`receivedAt`, not `occurredAt`.** `occurredAt` is client-supplied, so it is
both clock-skew-prone and attacker-controlled: a device with a wrong date
could present events that look months old and have them deleted early, or
look future-dated and never be deleted. `receivedAt` is set by Postgres when
the row lands, so the window is measured against our own clock.

**Bounded batches, not one statement.** A single `DELETE` over a quarter of
heartbeats takes a long row lock and a transaction large enough to bloat
WAL. Capped batches keep each transaction short, let ingestion continue
between them, and leave an interrupted run having made progress.

**A command, not a scheduler.** CLAUDE.md §18 rules out paid infrastructure,
and a cron container deleting rows that do not yet exist is infrastructure
maintained for no benefit. The sweep is idempotent and parameterised, so
scheduling it later is one line in whatever runs the deployment.

### ADR-36 — A failed ticket releases the player

The player released its decoder only for `EPISODE_LOCKED`. A ticket that
failed for any other reason left the *previous* episode loaded and playing,
still firing `timeUpdate`, so the recorder kept emitting
`playback_progress` at a position that could no longer change. M2.3's
offline test recorded ten such events at a frozen position.

**Decision.** Release on any ticket error. Heartbeats stop at their source
rather than being filtered downstream, and the decoder is freed while the
viewer looks at the retry state. The completed episode's progress is already
flushed by `handleEnded` with `immediate: true`, so nothing is lost.

`handleEnded` also became idempotent per episode. The controller's own guard
resets whenever a ticket is applied, so a retry after a failed next-episode
ticket could report the same episode complete twice — double-counting it in
the drop-off curve and advancing the feed twice.

---

# M2.5 — Production authentication and onboarding

### ADR-37 — Self-hosted email + password auth, not a managed provider

**Status:** Approved 2026-11-17 · implemented M2.5

ADR-06 chose Firebase for *identity proof* (Google Sign-In, phone OTP) and
deferred it under CLAUDE.md §18. M2.5 needed something different — email and
password, with recovery and verification — and that forced the question again.

**The comparison, with free tiers checked rather than assumed:**

| | Self-hosted | Firebase Auth | Supabase Auth |
|---|---|---|---|
| Cost | ₹0, no billing relationship | Free to 50k MAU for email/social | Free to 50k MAU |
| Phone OTP | Not attempted | **Requires a Cloud Billing account** since Sept 2024 | Needs an SMS provider |
| Recovery email | We build it; needs a sender | Included, hosted, hard to brand | **Default sender only reaches org members** since Sept 2024 — you need your own SMTP regardless |
| Operational catch | — | — | Free projects **pause after a week idle**; two active projects |
| Session layer | Ours | **Still ours** (ADR-07) | **Still ours** (ADR-07) |

**Decision: self-hosted, scoped to email and password.** Three reasons, in
order of weight:

1. **A managed provider does not remove work, it adds a system.** ADR-07
   already requires the backend to issue its own access token, because roles,
   entitlement and ban status must be ours and revocable — CLAUDE.md §11 is
   only satisfiable that way. Either option builds the same session layer;
   one of them also integrates, monitors and eventually migrates off a vendor.
2. **M2.5's scope is the cheap half of authentication.** Password hashing,
   rotation and single-use emailed tokens are solved problems with good
   primitives. The expensive half — phone OTP, meaning an SMS provider and DLT
   registration in India — is not in scope, and ADR-06 still covers it.
3. **It is additive, not a fork.** `User.firebaseUid` is nullable and already
   present. Firebase arrives later as a second `IdentityProvider` behind the
   same boundary, which is what ADR-06 said and what the code was shaped for.

**Google Sign-In is deferred, and not because it needs Firebase.** It needs an
OAuth client in Google Cloud Console, which is an external account this
milestone was told not to create. `POST /auth/google` drops into the same
module when that is approved.

**What we take on, stated plainly:** password hashing, reset-token handling,
enumeration resistance and credential rate limiting are now our
responsibility. That is the real cost, and it is why the decisions below are
not negotiable details.

---

### ADR-38 — Refresh tokens are SHA-256, not argon2

DATABASE_SCHEMA.md §3 specifies `Session.refreshHash` as an argon2 hash. It is
SHA-256, and the difference is not a shortcut.

**Argon2 is salted, so the same token hashes differently every time.** A
salted column cannot be looked up by hashing what the client presented: the
server would have to scan every session row and argon2-verify each one, at
roughly 50ms per attempt. That is not a refresh path.

**More importantly, it would make reuse detection impossible.** A replayed
token's row is exactly the thing that has to be *found* — revoked and all —
and with a salted hash it is unfindable. The replay would be indistinguishable
from a random string, and the single most valuable protection in the module
would silently not work.

**Argon2's cost buys resistance to brute force over a small search space.**
There is no small search space here: a refresh token is 32 bytes from
`crypto.randomBytes`. A preimage attack on SHA-256 of a 256-bit random value
is not a threat model. The property actually needed — a stolen database dump
yields no usable tokens — is given by any one-way hash.

Passwords are a different matter and do use Argon2id, at OWASP's 19MiB/t=2/p=1
baseline. The distinction is entropy, not importance.

---

### ADR-39 — Enumeration resistance costs a nicer error message

Registration, login and password reset all answer identically whether or not
an account exists. Three consequences were accepted deliberately:

**Registration returns no session.** Its response must be byte-identical for a
new address and a taken one, so it cannot carry a session for one of them. A
brand-new user therefore registers and then signs in. In practice almost
nobody takes that path — the app creates a guest session on first launch, so
the normal route is `POST /auth/merge`, which *can* return a session because
it requires the password for an existing address.

**The duplicate path emails the real owner.** "Someone tried to sign up with
your address" is what makes the silence toward the caller honest rather than
merely opaque.

**Login spends the full Argon2 cost on an unknown account.** Returning early
answers in under a millisecond where a real account takes ~50ms, and that
difference is measurable over the network. A stopwatch is as good as an error
message to someone enumerating accounts, so `verifyPassword` hashes against a
dummy and returns false.

A suspended account also fails with the wrong-password sentence. "This account
is suspended" confirms the account exists.

---

### ADR-40 — Revocation is immediate, at the cost of a read per request

Access tokens are stateless JWTs, which is what keeps a catalogue request from
costing a session lookup. Taken literally that means a password change cannot
reach tokens already in circulation, and "sign out whoever stole my session"
would be true only after fifteen minutes.

**`User.tokensValidFrom` closes the window.** It moves forward on a password
change or reset, and token verification refuses anything issued earlier.
`SessionIdentityProvider` therefore makes two indexed primary-key reads per
authenticated request — the user, and the session row behind the token.

**That is a stateless token doing a stateful check, and it is the right
trade.** ADR-07 already accepted a database read on the playback path for
entitlement, for the same reason: revocation that takes effect "within fifteen
minutes" is not revocation. If the read ever appears in a p95 measurement, the
fix is a short-lived cache of revoked session ids, not removing the check.

Reuse detection revokes a whole `familyId`, not one row. A replay means two
parties hold tokens from one chain and there is no way to tell which holder is
legitimate, so both lose it and the real user signs in again.

---

### ADR-41 — A guest is a server-side account, bound to the install

PD-6 settled this before M2.5 and the implementation confirmed it was right.
`POST /auth/guest` creates a real `User` row with `isAnonymous = true`, bound
to a client-generated `deviceId` so the account survives an app restart.

**The device id is a label, not a credential.** It resumes a guest session
only when a live, unrevoked session row is bound to it, and grants nothing on
its own — someone who learns another install's id gets a *new* guest account,
not that one. A test pins this.

**The merge has two cases, and the second is the one with teeth.** A free
address promotes the guest row in place, so nothing moves and nothing can be
lost in the moving. An address that already has an account folds the guest's
activity in **and requires that account's password** — without it, merge would
be a complete authentication bypass wearing the clothes of a convenience
feature.

**Conflicts keep the target's row.** Every engagement table is keyed
`(userId, somethingId)`, so a naive `UPDATE userId` hits a unique violation
the moment both accounts watched the same episode, and the whole merge fails.
Colliding rows are dropped instead and the registered account's record wins:
it is the one with an owner, and taking the larger position would silently
rewind someone who had watched further on another device.

The guest row is retired (`status = DELETED`) rather than dropped, so a
playback event arriving from the outbox a second after the merge still has a
valid reference (DATABASE_SCHEMA.md §6).

---

### ADR-42 — Mail is unavailable rather than absent, and only where it matters

No transactional mail service can be used without creating an external
account, which CLAUDE.md §18 defers. `FileMailProvider` writes each message to
`.mail-outbox/` and the flows are built and tested end to end against it.

**The first attempt refused to boot in production with a file provider.** That
was the wrong scope: it blocks a catalogue, a player and a watch history that
are all perfectly fine because password recovery is unconfigured — and it
broke two existing tests that had nothing to do with mail, which is how the
mistake surfaced.

**The refusal belongs to the flows that depend on delivery.**
`/auth/forgot-password` answers 503 in production with a file provider, rather
than promising an email that goes nowhere. Verification mail is *skipped* with
a warning instead, because it is not the point of the request that triggers it
— an unverified address still signs in and still watches, so failing a
registration over an unsendable confirmation would turn a missing integration
into an outage of the flow that brings new users in.

Scope a refusal to the thing that is broken.

---

### ADR-43 — Rate-limit keys, and the shared-NAT problem

ADR-34 flagged that IP-keyed limiting is unreliable on shared-NAT mobile
networks in India, and named a device-bound guest token as the real fix. M2.5
delivered it, and then hit the same problem twice more while testing.

**Credential endpoints are keyed on source address AND the address being
attacked.** An IP-only limit fails in both directions: tight enough to stop
guessing would lock out a neighbourhood, and someone with a pool of addresses
guessing one account never trips it at all. The email is hashed into the key,
since the key lives in a map that may appear in a heap snapshot.

**Two limiters were split out after tests caught them being wrong:**

- `reset-password` and `verify-email` carry a token and no email, so the key
  degrades to the source address alone. At the recovery limit of five per
  fifteen minutes, ordinary traffic trips it and the symptom is "the link in
  my email says it doesn't work". They get their own looser allowance — no
  rate limit is what makes a 256-bit token unguessable.
- `POST /auth/guest` was IP-keyed at five per window, which would have broken
  **first launch** for most of the launch audience. It is now keyed per
  install, with a looser per-IP backstop to bound someone forging device ids
  to create rows in bulk. One limiter could not do both jobs.

Both were found by a test suite that 429'd on itself. The in-process counter
limitation from ADR-34 is unchanged and still applies.

---

### ADR-44 — The auth bridge, and why the HTTP client cannot import the session

`services/auth/session.ts` imports `react-native` and `expo-secure-store`.
Neither loads under plain Node: React Native ships Flow-typed source, so
importing it outside Metro fails with `SyntaxError: Unexpected token 'typeof'`.

`tests/integration/backend.test.ts` loads the app's **real** `live-api` and
drives it at a running Express server — which is the whole value of it, since
it is what catches the client and the API disagreeing about a contract. A
static import of the session inside `http-client.ts` made that impossible, and
broke six integration tests the moment it was added.

**`services/api/auth-bridge.ts` is a registry with no dependencies.** The
client reads from it; the device registers the real session into it at
startup; Node gets the default, which is "no credential" — exactly right for a
guest-mode integration test. `HttpPlaybackSyncAdapter` solves the same problem
by taking its token getter as a constructor argument.

Those integration tests now obtain a **real guest session** instead of riding
the removed `EXPO_PUBLIC_DEV_AUTH_TOKEN`, which is strictly better coverage:
they exercise guest creation, the bridge and the authenticated request path,
where before they exercised a shared secret production never saw.

---

### ADR-45 — Concurrent refresh is collapsed into one request

The home screen fires several queries at once. If the access token has
expired, every one of them gets a 401 and every one tries to refresh. The
server rotates on first use (ADR-38), so the first succeeds and the rest
present a token that was just revoked — which the backend correctly reads as
**reuse** and answers by revoking the entire family.

**The app would sign the user out by opening a screen.**

`SessionManager` holds a single in-flight refresh promise that every caller
awaits, stored before it is awaited so a second caller arriving during the
first network round trip still finds it. The 401 retry path also checks
whether the current token has already moved on, and takes it rather than
rotating again.

**Two further rules, both about not losing a session that was fine:**

- A refresh that fails on transport — timeout, DNS, refused connection —
  leaves the credential in the keystore. Only a server rejection clears it.
  Losing a session on a train also orphans whatever the playback outbox had
  not yet uploaded, which is data loss dressed up as a security measure.
- Logout clears local credentials even when the server cannot be reached. A
  logout that refuses to work offline leaves credentials on a handset someone
  is about to hand over.

The HTTP client retries **at most once**. A second 401 after a successful
refresh means the request is unauthorised for a reason a new token cannot fix,
and retrying again is a loop that ends in a flat battery.

---

# M2.6 — Account lifecycle and privacy

### ADR-46 — A refused re-authentication is 403, not 401

**Status:** Approved 2026-11-18 · implemented M2.6

`change-password` answers a wrong current password with 401. Deletion does
not, and the difference is not stylistic.

**A successful deletion destroys the credential that would ask again.** Every
request after it — including a retry of the deletion itself — answers 401,
because the session row is gone and `tokensValidFrom` has moved. So if a wrong
password also answered 401, a client could not distinguish "I typed it wrong"
from "it already worked and I missed the response". That distinction decides
whether the app wipes the device.

**The caller is authenticated; it is the password that was refused.** Their
access token verified, their session is live, and it stays live. 403 is what
that means. 401 would also mislead the client's own retry logic, which treats
401 as "the session is finished".

**ADR-39's enumeration resistance does not apply.** It shapes the
*unauthenticated* endpoints, where a distinguishable answer reveals whether an
account exists. This endpoint requires a session, so there is nothing to
discover — the caller already knows the account exists, because it is theirs.

`change-password` was left on 401 deliberately. It has no lost-response
ambiguity, because a successful password change leaves the person signing in
again anyway, and moving it now would be a breaking contract change for no
benefit.

---

### ADR-47 — The deletion receipt, and why it is unauthenticated

**Status:** Approved 2026-11-18 · implemented M2.6 (refinement R1)

The first design treated any 401 after a deletion attempt as proof the
deletion had succeeded. That is wrong in a way that destroys data.

**A 401 has four causes and they are not interchangeable:** the access token
expired ordinarily mid-flow; the session was revoked elsewhere; the deletion
succeeded and the response was lost; or — not a 401 at all, but equally
ambiguous — the request never reached a server. Guessing "deleted" wipes a live
account's unsynced progress. Guessing "not deleted" leaves a deleted viewer's
watch history on the handset.

**The client generates a 256-bit receipt id and persists it to the keystore
BEFORE the request goes out.** It travels as `Idempotency-Key`, and the server
stores its SHA-256 hash on the `AccountDeletion` row inside the same
transaction that deletes the account. `POST /auth/deletion-receipt` then
answers "was a deletion recorded under this id?".

**Written before, not after, and that ordering is the whole mechanism.** The
case this exists for is an app killed between the request and the response. An
id written on success would not have been written at all.

**Unauthenticated by necessity, and without cost.** No credential survives the
deletion, so there is none to present. It leaks nothing: the only input is a
secret the client generated and the server never issues, the output is a
boolean and a timestamp, and the row behind it holds no identifier to return.
It is stored hashed for the reason `Session.refreshHash` is, and rate limited
on the loose token allowance for the reason `reset-password` is (ADR-43).

**Three invariants fall out of it,** each one a test:

- Nothing local is destroyed until a 200 or a positive receipt.
- A receipt lookup that *cannot be answered* keeps the pending receipt, so the
  next launch resolves it. A lookup that answers "no" clears it, because the
  attempt is settled.
- A 403 never consults the receipt at all. Nothing was deleted and the session
  is fine.

---

### ADR-48 — The audit row records the deletion, not the account

**Status:** Approved 2026-11-18 · implemented M2.6 (D3, refinement R2)

DATABASE_SCHEMA.md §6 requires deletion to be logged, and `AdminAuditLog` does
not arrive until M5. `AccountDeletion` is the consumer-side equivalent, built
to the opposite rule from an ordinary audit log: **what happened, never who it
happened to.**

It holds a pseudonymous `userId`, a source, a guest flag, timestamps, counts,
the playback-cleanup lifecycle and a receipt hash. It holds no email, phone,
`firebaseUid`, password, display name, token, device id, IP hash, or anything
about what was watched. A test serialises the whole row and asserts the address
does not appear in it, so a column added later that quietly carries one fails
without anyone having remembered to write an assertion for it.

**No foreign key to `User`,** for the reason `PlaybackEvent` has none: this row
records that an account ceased to exist and must not be removable by a cascade
from the table it describes. The id is written inside the deleting transaction,
so it always refers to a real row without a constraint saying so.

**Retention:** two years, matching §6's `AdminAuditLog` figure; the receipt
hash is nulled after thirty days, because recovery past that is pointless and
an unused secret should not outlive its purpose. Both are enforced by
`reconcile:deletions --prune`. No HTTP surface exposes the table today; M5
makes it admin-only.

---

### ADR-49 — Playback de-linking is observable, and reconciled by command

**Status:** Approved 2026-11-18 · implemented M2.6 (refinement R3)

Everything personal is deleted in one transaction. `PlaybackEvent.userId` is
nulled *after* it, because that is the only unbounded part of the work — a
heavy viewer accumulates tens of thousands of heartbeat rows inside the 90-day
window, and holding a transaction across them takes a long lock on the busiest
table in the database for an account that is already gone.

**The risk that creates is silence.** A process killed mid-sweep leaves rows
carrying a deleted user's id and nothing in a running system that would ever
notice.

**So the sweep records itself.** `playbackStatus` moves `PENDING →
IN_PROGRESS → COMPLETED | FAILED`, with a start time, a finish time, an attempt
count, a row count and a stable error code. A sweep that dies leaves
`IN_PROGRESS` with a start that never advanced, which is precisely the signal
the reconciler looks for.

**`reconcile:deletions` derives its work from state, not from a queue.** There
is no marker to go stale and nothing to replay. It also re-checks rows marked
`COMPLETED` against the events themselves — **a status that lies is worse than
one that is behind**, because `COMPLETED` is what tells an operator there is
nothing left to do.

**It reports, and refuses to touch, one specific class of row:** events whose
`userId` points at a `DELETED` user with no `AccountDeletion` record. Those are
guests retired by `mergeGuestInto` (ADR-41), whose events were deliberately
re-pointed at the account the person actually owns. A "tidy up all DELETED
users" sweep would destroy attribution the merge was careful to preserve. The
command names them and stops; a test pins that restraint.

A command rather than a scheduler, for the reason ADR-35 gives. Exit code 1
when anything is unrepaired, so it is usable as a health check the day there is
somewhere to run it.

---

### ADR-50 — Deletion wipes local SQLite; sign-out still does not

**Status:** Approved 2026-11-18 · implemented M2.6 (D8)

`applyAccountChange()` deliberately preserves the device's playback database on
sign-in and sign-out, because M2.5 Phase 5 required that unsynced progress
survive authentication — a guest upgrading in place has `pending_sync` rows
that would otherwise be deleted exactly when they were about to be uploaded.
**That rule is unchanged.**

Deletion overrides it, and is the only thing that does. After a deletion those
rows describe what somebody watched on an account that no longer exists:
`HttpPlaybackSyncAdapter` classifies the resulting 401 as non-retryable, so
they burn eight attempts and sit in `dead` forever, still on the handset.

`PlaybackService.purge()` stops the sync engine, drops every table, re-migrates
and restarts the engine. **The order is load-bearing in both directions:**
stopping first prevents a drain against a dead credential into tables about to
vanish; restarting last matters because the app keeps running — the viewer
lands on Home as a fresh guest and the next thing they watch needs somewhere to
record. A test asserts the database comes back migrated and writable, because
the failure mode is not an error, it is progress silently never saving again.

---

### ADR-51 — Authenticated password re-verification is rate limited

**Status:** Approved 2026-11-18 · implemented M2.6 (D7)

`POST /auth/change-password` shipped in M2.5 with no rate limit, and it
compares `currentPassword` against the stored hash. Anyone holding a stolen
access token therefore had an unbounded oracle for the real password — with
none of the per-address limiting that protects `/auth/login`. Account deletion
re-verifies the same way and would have added a second one.

One limiter now covers both, **keyed on the user id rather than the source
address.** The caller is already authenticated, so there is exactly one account
at risk and it is known by name. That is both tighter than an IP key and immune
to the shared-NAT problem that shapes every other key in `auth.routes.ts`
(ADR-43) — a legitimate viewer behind a carrier NAT is counted only against
themselves.

Five attempts per fifteen minutes. Nobody legitimately mistypes their own
password five times in a quarter of an hour, and the endpoints behind it are
both ones a person uses at most a few times in the life of an account.

---

### ADR-52 — CI verifies migrations from empty, and never caches a quality gate

**Status:** Approved 2026-11-22 · implemented M1.4

Four migrations were committed across M1.3 to M2.6 and nothing automatically
proved they apply, in order, to a database with nothing in it. They did apply —
the backend test harness does exactly that on a developer's machine — but only
as a side effect of running the suite, only locally, and only for whoever
happened to run it.

**The `migrations` CI job starts from an empty throwaway database and refuses
to start from anything else.** The first step asserts the public schema holds
no table, before any migration runs. Without that assertion, pointing the job
at a populated database would make `migrate deploy` report "No pending
migrations", every later step pass, and the job go green **having verified
nothing**. A green run that tested nothing is the worst outcome available here,
because nobody investigates one.

**`prisma migrate diff --exit-code` is the strongest check in the workflow.**
It compares the database the migrations built against `schema.prisma` and fails
on any difference. The failure it exists for is not a corrupted migration — it
is the ordinary one: a schema edit committed with no migration behind it, which
typechecks, generates a client, passes every test, and ships.

**`verify-schema.ts` overlaps it deliberately.** `migrate diff` is the stronger
assertion but prints a Prisma datamodel diff; the structural check prints
"table Session does not exist", which is the vocabulary of the person debugging
it. Its expectations are parsed out of `schema.prisma` at run time rather than
hand-listed, because a stale allow-list that passes is worse than no check.

**CI does not restore a Turbo cache.** A cache hit makes Turbo replay the
previous run's logs instead of executing the task — correct on a laptop, wrong
for a gate whose entire purpose is to have actually run. The pnpm store is
cached, because re-downloading packages proves nothing. On a repository this
size the difference is seconds.

**The test harness is not special-cased for CI.** The three guards from ADR-30
— the URL check, the post-connection `SELECT current_database()`, and `deploy`
rather than `dev` — run unchanged against the CI service container. The code
that protects a developer's data should be the code exercised on every pull
request, not the code least often tested.

Sentry and a staging environment are listed against M1.4 in the roadmap and are
**not** in this workflow. Both need an external account, which CLAUDE.md §18
defers until approved. See docs/MIGRATIONS.md for the operational detail.
