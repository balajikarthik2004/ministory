# MiniDrama — Development Roadmap

**Status:** Proposal v0.1 — awaiting approval
**Last updated:** 2026-11-15

Weeks are relative to approval, not calendar dates. Durations assume a small team (1 mobile, 1 backend, 1 full-stack/admin, shared QA). Sequencing matters more than the specific numbers.

---

## 1. Milestone Map

| Milestone | CLAUDE.md stage | Weeks | Exit criterion |
|---|---|---|---|
| **M1 — Foundation** | Stage 1 | 1–2 | Monorepo builds, CI green, player spike answered, docs approved |
| **M2 — Design system & shell** | Stage 2 | 3–4 | Token-driven components, navigation, screens with real states against mocked data |
| **M3 — Backend core** | Stage 3 | 4–6 | Auth, catalogue, history APIs live on staging with integration tests |
| **M4 — Streaming** | Stage 4 | 6–8 | Real episode plays end to end with signed tokens and entitlement enforcement |
| **M5 — Admin** | Stage 5 | 8–10 | Operator can publish a drama and upload an episode without engineering help |
| **M6 — Engagement** | Stage 6 | 10–12 | Search, favourites, notifications, recommendations |
| **M7 — Monetisation** | Stage 7 | 12–14 | Play Billing verified server-side; entitlement correct across the subscription lifecycle |
| **M8 — Hardening & release** | Stage 8 | 14–17 | Performance targets met on a real low-end device; security review passed; Play submission |

M2 and M3 run in parallel after M1 — mobile builds against the contract in `packages/contracts` while the backend implements it. That parallelism is the main reason the shared contract package is worth its cost.

---

## 2. M1 — Foundation (recommended first milestone)

**Goal:** prove the toolchain and the riskiest technical assumption before any feature code exists. No product features ship in M1, and that is the point.

### M1.1 — Monorepo skeleton ✅ **Complete (2026-11-15)**

- ✅ pnpm workspace with hoisted linking, Turborepo pipeline, Node 24.15
- ✅ Three app packages scaffolded; `packages/contracts`, `packages/config`, `packages/ui-tokens` created on a shared TS base (`strict`, `noUncheckedIndexedAccess`)
- ✅ ESLint 10 flat config + Prettier shared config, including the `no-restricted-imports` rule that enforces backend module boundaries (ARCH §2)
- ✅ `.gitignore`, `README.md`, `.env.example` per app
- ✅ Git repository initialised on `main` — **no commit made; awaiting explicit approval**

**Verified:** `pnpm install` clean · `pnpm peers check` clean · build, typecheck and lint green across all six packages · admin production build (7.6 kB CSS, 308 kB JS) · backend boots and serves `/health`, `/ready` and a correct 404 envelope · env validation refuses to boot on a bad variable · Android Metro bundle exports (1,227 modules).

**Risk gate (R-5): cleared for Expo Go.** The bundler is proven (1,227-module Android export) and the app was **confirmed running on a physical Android device via Expo Go on 2026-11-15** — Expo Router mounts, safe-area insets apply, and both workspace packages resolve on-device.

**Still open:** a custom development build (`expo run:android`) has not been run. It becomes necessary in M2 when `expo-video` arrives, since Expo Go does not bundle it. Producing that build is the first task of the M1.2 player spike, because the spike cannot run in Expo Go at all.

**Decisions taken during implementation:** TypeScript 6.0.3 (ADR-11), React pinned to 19.3.0 by workspace override (ADR-12), type-aware linting deferred (ADR-13). See docs/DECISIONS.md.

### M1.2 — Vertical player spike (the critical path) 🟡 **Harness built, measurements pending**

Harness, HLS fixture generator and adb profiling scripts are complete and verified to build; see [VIDEO_PLAYER_SPIKE.md](VIDEO_PLAYER_SPIKE.md). **Blocked on installing FFmpeg and adb** — both free, neither installed on the dev machine. No measurement has been taken and none is invented.

A throwaway Expo app, not production code, answering questions that determine the architecture of the most important screen:

1. Does a three-instance `expo-video` pool hold up under 30 fast swipes on a 4GB-RAM Android 12 device?
2. What is the actual time-to-first-frame from a signed Mux HLS URL on throttled 4G?
3. Does prewarming the next manifest measurably cut the gap between episodes?
4. What does memory do over a 10-minute continuous session? Does it plateau or climb?
5. How does playback behave when the network drops mid-episode and returns?

**Deliverable:** a written finding with numbers, a device name, and a go/no-go on the pooling approach. If TTFF cannot get under 1.5s, that changes PLY-04 and possibly the video provider — and it is much cheaper to learn now than in M8.

### M1.3 — Database foundation

- [x] Local Docker Compose for Postgres — PostgreSQL 16, persistent volume, health check, credentials from the root `.env`
- [x] Prisma schema from DATABASE_SCHEMA.md — 13 MVP models of the 28 specified; the rest are scheduled per DATABASE_SCHEMA.md §9.2 and ADR-18
- [x] First migration — `20261115153845_init_catalogue_identity_engagement`, verified against an empty database
- [x] Seed script — 6 languages, 9 categories, 2 Tamil sample dramas, 18 episodes, 1 test user; deterministic and idempotent
- [x] Backend integration — Prisma client singleton, connect at boot, disconnect on shutdown, database check on `/ready`
- [x] Migration dry-run wired into CI — delivered by M1.4; the `migrations` job applies all four migrations to an empty database on every PR

Prisma 7 needs a driver adapter and `prisma.config.ts` (ADR-17).

### M1.4 — CI and migration safety

- [x] GitHub Actions workflow — `.github/workflows/ci.yml`, five jobs on every PR and push to `main`
- [x] Code quality gate — lint, typecheck and `format:check` across all six workspaces
- [x] Test gate — backend suite against a real Postgres service, mobile suite, mock-catalogue verification
- [x] **Migration verification from an empty database** — `migrate deploy`, `migrate status`, `migrate diff --exit-code` drift check, and a structural assertion over tables, enums, indexes and constraints
- [x] Build gate — backend, admin production build, shared packages, Expo Android export
- [x] Migration safety documentation — `docs/MIGRATIONS.md`, ADR-52
- [x] Formatting enforced — the 44 files that predated the gate reformatted once

Deferred, each needing an external account that CLAUDE.md §18 holds until approved:

- [ ] Sentry projects for all three apps
- [ ] Staging environment provisioned (host decision from ARCH §11)

No deployment, no EAS build, no mobile publishing. The Expo step exports a
bundle to prove it compiles and resolves its assets; it produces no APK or AAB.

### M1.5 — Contract package seeded

Zod schemas for the auth and catalogue endpoints from API_DOCUMENTATION.md §2 and §4, with OpenAPI generation wired up. These are the endpoints M2 and M3 both depend on, so they need to exist before either starts.

### M1 exit checklist

- [ ] `pnpm install && pnpm typecheck && pnpm lint && pnpm test` passes from clean
- [ ] Android dev build runs on a physical device
- [ ] Player spike findings documented with measured numbers
- [ ] Migration applies to a fresh database and seeds successfully
- [ ] CI green on a PR
- [ ] Staging backend returns `200` on `/health`
- [ ] All eight approval items in SYSTEM_ARCHITECTURE.md §12 decided

**M1 ships no user-facing feature. It de-risks the three things that can cost a month later: toolchain, player, and schema.**

---

## 3. M2 — Design System & App Shell (Stage 2)

Tokens in `packages/ui-tokens` (colour, spacing and type land in M1.1; the rest follow) · a **token-to-CSS generator** so the admin Tailwind theme stops hand-mirroring token values — see DECISIONS.md "Known deviation to resolve" · the full primitive and composite component inventory (UI_UX_GUIDELINES.md §4) · Expo Router navigation · `react-router-dom` and the admin shell · Splash, Home, Drama Detail, Player UI, Search, My List and Profile built against mocked data conforming to `packages/contracts`.

Every screen implements loading, empty, error and offline states. A screen without all four is not reviewable.

**Exit:** navigable app on device, all four states demonstrable per screen, zero hardcoded colours or sizes in component files.

### M2.1 — Mobile app UI ✅ **Complete — verified on a physical device (2026-11-16)**

Seven screens, a token-driven component library, four-tab navigation and a
full-screen vertical player, all against mocked data.

- [x] Design-token component library — primitives (`AppText`, `Button`, `IconButton`, `Chip`, `Badge`, `Skeleton`, `ProgressBar`, `SearchInput`, `Gradient`, `PressableScale`), feedback (`EmptyState`, `ErrorState`, `SectionHeader`) and catalogue composites (`DramaCard`, `DramaRail`, `FeaturedBanner`, `ContinueWatchingCard`, `EpisodeListItem`, `Artwork`, `Wordmark`, `AppHeader`). Zero raw hex or font sizes in any component file.
- [x] Navigation — `index` (splash) → `(tabs)` Home · Search · My List · Profile, with `drama/[slug]` and `player/[slug]` pushed above the tab group so the player is never framed by a tab bar. Typed route params.
- [x] Screens — Splash, Home, Search, Drama Detail, Vertical Player, My List (saved + history), Profile. Every data-backed screen implements loading (content-shaped skeletons), empty, and error-with-retry.
- [x] Vertical player — Strategy A single player per VIDEO_PLAYER_SPIKE.md §10, behind a `VideoPlayerController` interface. Swipe paging, play/pause, mute, 10s seek, progress, auto-hiding controls, loading and error/retry states, lifecycle release on unmount.
- [x] Mock data — 8 Tamil dramas, 75 episodes, validated against `packages/contracts` at module load; `tools/verify-mock-catalogue.mjs` re-runs the same parses in Node (137 checks).
- [x] Contract package extended with the catalogue, library and playback schemas (the half of M1.5 this milestone needed).
- [x] Original placeholder artwork generated offline — `tools/placeholder-art/generate.mjs`, 24 PNGs, no external image service.
- [x] **Device run** — Motorola Edge 70 Fusion, Android 17, Expo Go over `adb reverse`. Every screen opened, navigation walked end to end, and the player played real HLS from the local fixture server. Six defects found and fixed; see below.
- [ ] Offline state — the fourth required state is not implemented. There is no connectivity source yet (`@react-native-community/netinfo` or `expo-network` would be a new dependency) and nothing to queue writes to until M3. Error-with-retry covers the failure path meanwhile.
- [ ] Onboarding (language / genre / sign-in prompt) — deferred with authentication to M3.
- [ ] Token-to-CSS generator for the admin theme — still open, unchanged by this milestone.

**Verified:** `pnpm typecheck` · `pnpm lint` · `pnpm format:check` green across all nine workspace tasks · Android Metro export clean (3.5 MB Hermes bundle, 24 assets) · `expo install --check` reports dependencies in step with SDK 58 · mock catalogue 151/151 checks · **on-device run on a Motorola Edge 70 Fusion (Android 17)**.

**Dependencies added:** `zustand`, `@tanstack/react-query`, `@expo/vector-icons`. Reanimated and `expo-linear-gradient` deliberately not added — see DECISIONS.md ADR-19.

#### Defects found by the device run

None of these were visible in typecheck, lint or the bundle export. They are recorded because each one is a class of mistake worth recognising again.

| # | Defect | Cause | Fix |
|---|---|---|---|
| 1 | Opening a resumed episode skipped straight to the next one | Catalogue reported invented 88–112s durations while serving 20–90s fixtures. A seeded resume position of 88s landed past the end of a 45s stream, so the player hit `playToEnd` before rendering a frame. | One `FIXTURES` table drives both the reported `durationSec` and the playback URL. A verification check now compares both against the FFmpeg manifest. |
| 2 | Episode header and clock disagreed mid-swipe ("Episode 3 · 0:45 / 0:45") | Between a swipe settling and the next ticket arriving, the overlay paired the new episode's title with the previous episode's playback snapshot. | The overlay renders a reconciled snapshot that falls back to the episode's own declared duration until the controller holds that episode. |
| 3 | Pages misaligned after the first swipe — video filled three quarters of the viewport | Page height came from `Dimensions.get('window')`, which is not the list's viewport under `edgeToEdgeEnabled`. `pagingEnabled` snaps to the scroll view's own frame, so the two drifted by one bar's worth per page. | The list measures its own height with `onLayout` and sizes pages from that. |
| 4 | **Every caller's layout style was silently dropped by `PressableScale`** | The component rendered `<Pressable><Animated.View style={style}>`, so the flex child of the parent was an unstyled `Pressable`. `flex`, `alignSelf`, `width` and margins never applied. Visible as the Profile stat tiles collapsing to label width **and the bottom tab bar crowding into the left third of the screen**. | The caller's style goes on an animated `Pressable`, so layout, touch and transform are one element. |
| 5 | Buttons left-aligned in centred containers | Surfaced by fix 4: `Button`'s hug style set `alignSelf: 'flex-start'`, which had previously been inert. | `hug` centres, and a caller can override through `style`. |
| 6 | Scrolled content collided with the status bar | Edge-to-edge is deliberate for the hero, but ordinary content scrolling up to meet the clock is not. | A `TopScrim` over the inset on Home, Drama Detail and Profile. |

A seventh issue was caught before reaching the device: `load()` re-applied a ticket whenever the phase was `error`, and because the phase was a dependency of that callback, an error re-ran the caller's effect and reloaded — an unbounded retry loop against a failing stream. Recovery is now the user-driven `retry()` only.

**Also confirmed working on device:** resume at the stored position · swipe-to-next · auto-advance at end of episode · `EPISODE_LOCKED` refusal rendering the unlock panel · favourite state shared across home, search, detail and player · Tamil, Telugu, Hindi, Malayalam and Kannada glyphs rendering in the language picker.

### M2.2 — Playback events, offline queue and durable progress ✅ **Complete**

The telemetry pipeline and the offline foundation HIST-06 needs, with no
server involved — M2.3 implements ingestion behind the adapter interface that
is already in place.

- [x] **Playback event taxonomy** — eight types in `packages/contracts`, each with a written definition because an analytics event whose meaning is ambiguous produces numbers nobody trusts (ADR-26).
- [x] **SQLite outbox** — `expo-sqlite`, three tables, `PRAGMA user_version` migrations. Event id is the primary key, so enqueueing is idempotent (ADR-23).
- [x] **Durable watch progress** — per-episode rows plus a per-drama head, mirroring the server's `WatchHistory`/`DramaProgress` split. Survives restart; Continue Watching reads from it.
- [x] **Sync engine** — mutex, exponential backoff with jitter (2s → 5min cap), eight attempts then `dead`, partial-accept handling, and recovery of rows left in flight by a killed process.
- [x] **Connectivity** — `expo-network` behind an interface; gates on `isInternetReachable`, not just `isConnected`, so a captive portal does not burn retries.
- [x] **Offline UI** — connection banner with a pending count and retry, a reconnected confirmation, and a sync panel on Profile that exposes the queue and (in development) lets the failure paths be driven on real hardware.
- [x] **Test foundation** — 83 tests via Node's built-in runner, executing real SQL through `node:sqlite` (ADR-24). `pnpm test` runs them.

**Throttling** — the player ticks twice a second; progress is persisted at most every 5 seconds and a heartbeat is emitted at most every 15. Pause, completion and screen teardown flush immediately, so the worst case on an unclean kill is five seconds of lost position.

**Verified:** `pnpm typecheck` · `pnpm lint` · `pnpm format:check` · `pnpm test` (83/83) · `verify:mocks` (151/151) · Android export clean (3.7 MB Hermes, 1,611 modules) · `expo install --check` in step with SDK 58.

**Dependencies added:** `expo-sqlite`, `expo-network`, `expo-crypto` (all Expo SDK, free, bundled in Expo Go) and `@types/node` for the test config. No test framework was added — see ADR-24.

**Deliberate non-goals:** no video downloads and no claim that HLS plays offline; the banner says what actually still works. No backend endpoint was invented (CLAUDE.md §16.13) — the adapter interface is the seam M2.3 fills.

### M2.3 — Backend API integration ✅ **Complete; verified on a physical device**

The mobile app talks to Express and PostgreSQL. Mock mode is retained.

- [x] **Catalogue API** — `/home`, `/dramas`, `/dramas/:idOrSlug`, `/dramas/:id/episodes`, `/categories`, `/languages`, `/search`. Cursor pagination, three sorts, language and category filters, published-only enforced in the repository rather than by callers.
- [x] **Playback ingestion** — `POST /playback/events`. `eventId` as the primary key, partial acceptance, `occurredAt`/`receivedAt` split, batch cap, guest-tolerant.
- [x] **Library API** — Continue Watching, history, favourites (idempotent, counter kept in step), progress with the monotonic rule.
- [x] **Development identity** — behind an `IdentityProvider` interface, four guards against production use (ADR-27).
- [x] **Mobile adapter** — `services/api` selects mock or live from one env var; `HttpPlaybackSyncAdapter` replaces the mock sync adapter; the M2.2 outbox and sync engine are unchanged.
- [x] **Additive migration** — `20261116092214_add_playback_event_telemetry`. `CREATE TYPE` + `CREATE TABLE` only; no `ALTER` on any existing table, and M1.3's migration is untouched.
- [x] **Documentation corrected** — SYSTEM_ARCHITECTURE.md §4 (SQLite, not AsyncStorage) and §8 (eight-value taxonomy, at-least-once delivery); DATABASE_SCHEMA.md §3 annotated; the ADR table extended with ADR-23 to ADR-26.
- [x] **Tests** — 100 backend, 94 mobile (11 of them mobile→backend integration against a running server).

**Seed changed, deliberately:** episode durations now come from the same table as the fixture each episode streams. The seed previously recorded a flat 90 s against 20–90 s media — the exact mismatch M2.1's device run caught in the mobile mock. The catalogue also grew from 2 dramas to 8, because two cannot demonstrate pagination, a genre filter or a rail.

**Conflicts found and resolved** (reported before implementing, per the brief):

| Conflict | Resolution |
|---|---|
| DATABASE_SCHEMA.md specifies a 5-value `PlaybackEventType`; the shipped client produces 8 | The client wins. Model matches the contract; the document is annotated as superseded (ADR-26, ADR-28). |
| DATABASE_SCHEMA.md specifies `PlaybackEvent.id BigInt @default(autoincrement())` | The client's UUID is the primary key, so idempotency is a database constraint (ADR-28). |
| Seeded durations (flat 90 s) contradict the fixtures served (20–90 s) | Seed corrected; a backend test asserts episode durations are not uniform. |

**Incident:** the first version of the test harness isolated by Postgres *schema*, which the Prisma driver adapter does not honour — the suite ran against `public` and emptied the development database. Restored from the deterministic seed. Now isolated by separate database with a `SELECT current_database()` guard. Full account in DECISIONS.md **ADR-30**.

---

### M2.4 — Reliability and backend hardening ✅ **Complete; verified on a physical device**

Three defects carried out of M2.3, plus the hardening the ingestion path needed before it carries real traffic.

- [x] **Issue A — progress consistency.** Home read server progress; drama detail read the device’s SQLite copy, and nothing reconciled them. One rule now lives in `services/resume.ts`, resolved from server-supplied `watchState`, and both screens call it (ADR-31). On device: Home "EP 4" and detail "Resume Episode 4" agree, where they previously said EP 3 and EP 2.
- [x] **Issue B — player released on ticket failure.** Release happened only for `EPISODE_LOCKED`, so any other failure left the previous episode decoding and emitting `playback_progress` at a frozen position — ten such events in M2.3’s offline test. Release now happens on any ticket error, and `handleEnded` is idempotent per episode so a retry cannot double-count a completion (ADR-36). On device: four events for the episode, zero frozen heartbeats across an 86-second failure window.
- [x] **Issue C — completed dramas leave Continue Watching.** `DramaProgress.isCompleted` was never set, and the rail offered the episode last watched rather than the next one. Both halves fixed; completion is recomputed rather than sticky, so publishing a new episode brings a finished drama back (ADR-33).
- [x] **Rate limiting** — 120 requests/minute per caller on `POST /playback/events`, in-process, no new dependency. Sized so a real offline backlog cannot trip it; refusals are 429/`RATE_LIMITED`, which the sync adapter retries rather than discarding (ADR-34).
- [x] **90-day retention** — `pnpm --filter @minidrama/backend retention:events`, measured on `receivedAt`, bounded batches, idempotent, dry-run supported. A command rather than a scheduler, per the free-first policy (ADR-35).
- [x] **Durable progress sync** — `watch_progress.pending_sync` (local schema v2). Replayed on startup, foreground and reconnect. A dirty flag rather than a queue, because one row per episode already holds the latest position (ADR-32).
- [x] **Tests** — 121 backend, 116 mobile. New: retention boundary and idempotency, rate limiting and backlog tolerance, Continue Watching completion behaviour, the resume rule, and progress write-failure recovery.

**No migration.** PostgreSQL is unchanged; the only schema change is the mobile app’s local SQLite, which gained one column under its own forward-only `user_version` chain.

**Known limitations carried forward:** the rate limiter counts per process and is not correct behind more than one instance; `EpisodeDailyStat` rollups are still unbuilt, so retention protects a table nothing yet reads; and Continue Watching can offer a premium episode, which opens the unlock panel rather than playing.

---

### M2.5 — Production authentication and onboarding ✅ **Complete; verified on a physical device**

Real sessions replace the M2.3 development identity. Self-hosted email and password, chosen over a managed provider after a free-tier comparison (ADR-37); Firebase remains ADR-06's plan for Google and phone OTP.

- [x] **Backend** — register, login, logout, refresh, current user, password change, password reset, email verification, guest sessions and guest→account merge. Argon2id at OWASP's 19MiB/t=2/p=1 baseline; refresh tokens stored as SHA-256 and rotated on every use (ADR-38).
- [x] **Refresh-token reuse detection** — a replayed token revokes the whole session family, not just the row (ADR-40). The most valuable protection in the module, and the one a salted hash would have silently disabled.
- [x] **Immediate revocation** — `User.tokensValidFrom` invalidates access tokens already in circulation, so a password change does not take fifteen minutes to take effect. Costs two indexed reads per authenticated request, accepted for the same reason ADR-07 accepted one.
- [x] **Enumeration resistance** — registration, login and reset answer identically whether or not an account exists, and login spends the full Argon2 cost on an unknown address so timing does not give it away (ADR-39).
- [x] **Rate limiting** — credential endpoints keyed on source *and* the address being attacked. Two limiters were split out after tests caught them being wrong: token-bearing endpoints and guest creation would both have broken real traffic behind a carrier NAT (ADR-43).
- [x] **Mobile** — login, register, forgot-password, reset-password, verify-email and a skippable two-step onboarding. Refresh token in `expo-secure-store`, access token in memory only, never AsyncStorage.
- [x] **Concurrent refresh** — collapsed into one in-flight request. Without it, four parallel queries on the home screen would each rotate, and the server would correctly read that as reuse and sign the user out (ADR-45).
- [x] **Development identity removed from the client** — `EXPO_PUBLIC_DEV_AUTH_TOKEN` is gone, not disabled: every `EXPO_PUBLIC_` value is extractable from a shipped APK. Production registers the session provider and refuses the development one at boot.
- [x] **Guest continuity** — a guest is a real server-side account bound to the install. Merging into an existing account requires that account's password; conflicting rows keep the registered account's values rather than failing the merge (ADR-41).
- [x] **Tests** — 174 backend (was 121), 135 mobile (was 116). The backend suite runs against a real Postgres test database and the mobile integration suite drives the real client at a running API with a real guest session.
- [x] **Physical-device verification** — completed; the checklist below was exercised on a handset.

**Migration:** `20261117060610_add_auth_sessions_and_verification_tokens`. Additive only — two enums, three nullable `User` columns, `Session` and `VerificationToken`. Applied with `migrate deploy`; the development database was never reset.

**Device verification checklist.** Cold start resolves a guest session and routes within 1.5s (AUTH-01) · onboarding appears once and is skippable · Continue Watching survives an app restart · register from a guest session keeps watch history (AUTH-06) · sign out clears credentials and returns to a guest session (AUTH-08) · force-stop and relaunch restores the session from the keystore · aeroplane mode mid-session does not sign the viewer out · a reset link from `.mail-outbox/` opens the reset screen via the deep link.

**Known limitations carried forward:** no real mail sender, so password reset answers 503 in production and the development outbox is a directory (ADR-42); Google Sign-In and phone OTP are still deferred; the rate limiter still counts per process (ADR-34). Account deletion (AUTH-09) was closed by M2.6 below.

---

### M2.6 — Account lifecycle and privacy ✅ **Complete; verified on a physical device (2026-11-18)**

AUTH-09 closed: in-app account deletion, an audit record that holds no identifier, and the public page. Design of record: `M2.6_ACCOUNT_DELETION_DESIGN.md`.

- [x] **Deletion is one transaction** — a conditional `updateMany` on `status` gates, locks and scrubs the identifiers in a single statement, which makes concurrent deletions resolve in the database rather than in application logic (the same idiom as `consumeVerificationToken`). Profile, sessions, verification tokens, watch history, progress and favourites are hard-deleted explicitly, because the `User` row is anonymised rather than dropped and no cascade ever fires.
- [x] **`Drama.favoriteCount` is decremented** — a bulk delete that skipped it would inflate every affected drama's counter permanently, and nothing in the system recomputes it (DATABASE_SCHEMA.md §9.5). A test seeds two users favouriting one drama and asserts the survivor is still counted.
- [x] **Sessions die immediately** — session rows deleted, `tokensValidFrom` moved, `status` no longer `ACTIVE`. `SessionIdentityProvider` fails on any one of the three independently.
- [x] **A refused password is 403, not 401** (ADR-46) — because a *successful* deletion makes every later request 401, and collapsing the two would leave a client unable to tell "I typed it wrong" from "it already worked and I missed the response".
- [x] **The deletion receipt** (ADR-47) — a 256-bit id written to the keystore *before* the request, sent as `Idempotency-Key`, stored hashed in the deleting transaction. `POST /auth/deletion-receipt` answers "did it happen?" with no credential, because deletion destroys every credential that could ask. Nothing local is wiped until a 200 or a positive receipt; an unresolved attempt is settled on the next launch.
- [x] **Observable playback de-linking** (ADR-49) — `PlaybackEvent.userId` is nulled after the transaction with its own recorded lifecycle, so a sweep killed mid-run is visible. `reconcile:deletions` finishes it, re-checks rows that merely *claim* to be done, and reports — without touching — merged guests' events.
- [x] **Local wipe on deletion only** (ADR-50) — `PlaybackService.purge()` stops the sync engine, drops the tables, re-migrates and restarts it. Sign-out still preserves the database, which is M2.5's rule and stays.
- [x] **`change-password` rate limited** (ADR-51) — it compares the current password and had no limiter, so a stolen access token was an unbounded password oracle. One user-keyed limiter now covers it and deletion.
- [x] **Mobile** — a two-screen flow in `(settings)`: consequences, then re-authentication (password, or typing `DELETE` for a guest, which has none). Deleting and done states are not cancellable; a transport failure says plainly that nothing was removed.
- [x] **Public page** — `GET /account-deletion`, static, no form, no JavaScript. Explains the in-app steps, what is deleted and what is kept.
- [x] **Tests** — 208 backend (was 174), 158 mobile (was 148 + 10 skipped). 24 deletion cases, 10 reconciliation cases, 16 mobile state-machine and purge cases.
- [x] **Physical-device verification** — run on a Motorola Edge 70 Fusion against the live API. Both deletion paths exercised end to end, and the unconfirmed-deletion invariant reproduced by stopping the server mid-flow.

**Migration:** `20261118045211_add_account_deletion_audit`. Additive only — two enums, one enum value, `AccountDeletion` and its indexes. No column dropped, no existing table altered, no data rewritten. Applied with `migrate deploy`; the development database was never reset and the existing accounts and catalogue are untouched.

**Decisions taken:** immediate deletion rather than a grace period (no scheduler, and ADR-08 still defers pg-boss) · guests may delete with a typed confirmation · the audit table was added · the public page is static in v1 and the email-initiated web flow waits on a real sender, because promising "check your inbox" with `MAIL_PROVIDER=file` is the mistake ADR-42 exists to prevent · `DELETE /auth/account` keeps a request body · hosting of the public URL stays deferred with SYSTEM_ARCHITECTURE.md §11.

**Device verification, as run (2026-11-18, Motorola Edge 70 Fusion, live API).**

| Check | Result |
|---|---|
| Registered account with watch history, progress and 11 sessions deleted from Profile | ✅ landed on Home as a fresh guest; Continue Watching gone |
| Wrong password first | ✅ inline "That password is not correct", **session stayed usable** — the 403-not-401 behaviour (ADR-46) |
| Database after deletion | ✅ `status=DELETED`, every identifier null, 0 child rows, audit row counts matched exactly (1/1/0/11/1) |
| Playback events | ✅ 7 de-linked, 0 deleted, sweep `COMPLETED` in one attempt |
| Deleted account sign-in | ✅ refused with the generic credentials sentence |
| Guest deletion via typed `DELETE` | ✅ `wasAnonymous=true`, receipt recorded |
| Guest-specific copy | ✅ "removes the temporary account this device has been watching with" |
| **Deletion attempted with the server stopped** | ✅ "We could not reach MiniDrama… Nothing on this device has been removed" — **nothing wiped**, local progress intact |
| Pending receipt resolved on next launch | ✅ server said no deletion was recorded; receipt cleared, no teardown, Continue Watching still there |
| Public page on the handset's browser | ✅ renders, steps match the real flow |
| Reconciler after the run | ✅ 0 unfinished, 0 residue, 3/3 sweeps `COMPLETED` |

**Not reproduced on the device:** killing the app in the ~100ms window between the delete request and its response. The resolution path either side of it was exercised (a pending receipt was created, survived, and was resolved at launch); the kill itself is covered by `tests/auth/deletion-flow.test.ts`.

**Legal claims are flagged, not published.** No statute, regulation, policy name or legal retention period appears on the public page, in any in-app copy, or in any API response — only what the system actually does. The assumptions that previously sat in DATABASE_SCHEMA.md §6 are listed as unverified in the design document §11, and the financial-record retention figure quoted during review has been withdrawn.

**Known limitations carried forward:** the web-initiated deletion request (`/auth/request-deletion`, `/auth/confirm-deletion`) is designed but unbuilt pending a mail sender; avatar objects will need deleting from object storage once M4 introduces it, and that obligation is recorded against the storage provider rather than implemented; the public page's URL is not final.

---

## 4. M3 — Backend Core (Stage 3)

Express + TS skeleton with the full middleware pipeline (ARCH §5) · Zod-validated env config that refuses to boot on a bad secret · Firebase Admin verification, session issue/refresh/revoke, guest accounts and the merge transaction · Catalogue modules (dramas, seasons, episodes, categories, languages) with cursor pagination · `/home` composition · watch history and `DramaProgress` · favourites · centralised error handling and structured logging.

**Exit:** every M3 endpoint has an integration test against a real test database; the mobile app's mocks are replaced with live staging calls; p95 under 300ms on seeded data.

---

## 5. M4 — Streaming (Stage 4)

Mux account and signing keys · `VideoProvider` abstraction (ADR-07) · direct-upload URL issue · webhook handler with signature verification and idempotency · the playback-token endpoint with full entitlement evaluation · HLS playback wired into the real player · playback-event ingestion · the stuck-asset reconciliation job (R-6).

**Exit:** an episode uploaded through the API plays on a device via a signed URL; a premium episode returns `EPISODE_LOCKED` for an unentitled user; a replayed webhook causes no duplicate state.

**This is the milestone where the product first exists.** Everything before it is scaffolding.

---

## 6. M5 — Admin (Stage 5)

Admin auth with argon2id, TOTP for SuperAdmin, separate token audience · RBAC middleware driven by the matrix in API_DOCUMENTATION.md §3 · dashboard metrics · drama, season and episode CRUD · Mux direct upload with the progress and status UI (UI_UX_GUIDELINES.md §6) · publish/unpublish/schedule · user list and status management · audit logging on every mutation.

**Exit:** a non-engineer publishes a complete drama with five episodes, unaided, and it appears in the mobile app.

---

## 7. M6 — Engagement (Stage 6)

Trigram search with filters and trending terms · favourites sync and the notification fan-out job · Expo push with device registration and preferences · the rule-based recommender · nightly `popularityScore` job · content-report submission and the moderation queue.

---

## 8. M7 — Monetisation (Stage 7)

Play Billing integration · server-side purchase verification · RTDN via Pub/Sub for the full subscription lifecycle · nightly entitlement reconciliation (R-3) · coin wallet, idempotent spend and episode unlock (pending PD-1) · rewarded ads (pending PD-3) · restore purchases · admin revenue view.

**Exit:** every state transition in the Play lifecycle — renew, cancel, grace, hold, refund, restore on a new device — is verified against a Play test account. Entitlement must never disagree with Play.

---

## 9. M8 — Hardening & Release (Stage 8)

Performance pass against the NFR table on a real low-end device · Maestro flows for the critical paths (first play, resume, swipe-to-next, purchase, locked-episode flow) · security review against CLAUDE.md §11 · load test on the playback-token path · database restore drill (R-8) · accessibility audit · **legal and compliance review for IT Rules 2021 and DPDP (R-4)** · Play Store assets, Data Safety declaration, staged rollout.

---

## 10. Testing Cadence

| Layer | Scope | When |
|---|---|---|
| Unit | Services, entitlement logic, reducers, utils | Every PR |
| Integration | API endpoints against a real test DB | Every PR |
| Component | RN components with Testing Library | Every PR |
| E2E (Maestro) | First play, resume, swipe-to-next, purchase, locked episode | Nightly on staging |
| Manual device | Low-end Android, poor network, interruptions | Each milestone close |
| Load | Playback-token and event-ingest paths | M4 and M8 |

Coverage targets: entitlement, auth and payment logic at 90%+; everything else at a level that makes refactoring safe rather than a number that makes a dashboard green.

---

## 11. Dependency Checklist

Procurement lead time, not engineering time, is what delays these. All should be started during M1.

| Item | Needed by | Owner |
|---|---|---|
| Mux account + signing keys | M4 | Eng |
| Firebase project (Auth, FCM, Analytics) — Blaze plan for phone OTP | M3 | Eng |
| Cloudflare R2 bucket + CDN domain | M3 | Eng |
| Google Play Console account | M7 | Business |
| Play Developer API service account + Pub/Sub topic | M7 | Eng |
| AdMob account (if PD-3 approved) | M7 | Business |
| Sentry org | M1 | Eng |
| Managed Postgres + API host | M1 | Eng |
| Domain + TLS | M1 | Business |
| Launch content (PD-7) | M8 | Content |
| Grievance officer + policy pages (R-4) | M8 | Legal |

---

## 12. Blocking Decisions by Milestone

| Needed before | Decisions |
|---|---|
| M1 | Monorepo layout · pnpm vs npm · hosting · auth strategy · job runner (ARCH §12 items 1–5, 7) |
| M3 | PD-4 language strategy · PD-6 guest identity · PD-5 age rating |
| M4 | Video provider confirmation · PD-7 launch volume for the cost model |
| M7 | PD-1 monetisation model · PD-2 pricing · PD-3 ad network |
| M8 | Compliance scope (R-4) · launch markets |

A decision made late is a decision that costs a migration. The M1 set is the one worth answering this week.
