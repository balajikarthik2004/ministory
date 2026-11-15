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

### M1.2 — Vertical player spike (the critical path)

A throwaway Expo app, not production code, answering questions that determine the architecture of the most important screen:

1. Does a three-instance `expo-video` pool hold up under 30 fast swipes on a 4GB-RAM Android 12 device?
2. What is the actual time-to-first-frame from a signed Mux HLS URL on throttled 4G?
3. Does prewarming the next manifest measurably cut the gap between episodes?
4. What does memory do over a 10-minute continuous session? Does it plateau or climb?
5. How does playback behave when the network drops mid-episode and returns?

**Deliverable:** a written finding with numbers, a device name, and a go/no-go on the pooling approach. If TTFF cannot get under 1.5s, that changes PLY-04 and possibly the video provider — and it is much cheaper to learn now than in M8.

### M1.3 — Database foundation

- Prisma schema from DATABASE_SCHEMA.md, first migration, seed script with languages, categories and two sample dramas
- Local Docker Compose for Postgres
- Migration dry-run wired into CI

### M1.4 — CI/CD and observability baseline

- GitHub Actions: typecheck, lint, test, migration dry-run on every PR
- Sentry projects for all three apps
- Staging environment provisioned (host decision from ARCH §11)

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

Tokens in `packages/ui-tokens` (colour, spacing and type land in M1.1; the rest follow) · a **token-to-CSS generator** so the admin Tailwind theme stops hand-mirroring token values — see DECISIONS.md "Known deviation to resolve" · the full primitive and composite component inventory (UI_UX_GUIDELINES.md §4) · Expo Router navigation with `(auth)` / `(tabs)` / `(player)` groups · `react-router-dom` and the admin shell · Splash, Onboarding, Home, Drama Detail, Player UI, Profile built against mocked data conforming to `packages/contracts`.

Every screen implements loading, empty, error and offline states. A screen without all four is not reviewable.

**Exit:** navigable app on device, all four states demonstrable per screen, zero hardcoded colours or sizes in component files.

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
