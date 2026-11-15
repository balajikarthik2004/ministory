# MiniDrama — Architecture Decision Record

**Status:** ADR-01 … ADR-10 approved 2026-11-15. ADR-11 … ADR-16 are implementation decisions made during Milestone 1.1 and are open to revision.
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

## Known deviation to resolve

**Admin Tailwind theme duplicates the token values.** `apps/admin/src/index.css` hand-mirrors the hex values from `@minidrama/ui-tokens` into a Tailwind v4 `@theme` block, because CSS cannot import a TypeScript module. Two sources of truth for the same colours is exactly the drift `packages/ui-tokens` exists to prevent.

Resolution in M2: a small generator in `ui-tokens` emits a CSS custom-property file that the admin imports. Marked with a comment in the CSS and tracked in DEVELOPMENT_ROADMAP.md §3.
