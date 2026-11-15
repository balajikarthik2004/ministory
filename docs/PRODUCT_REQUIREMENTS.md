# MiniDrama — Product Requirements

**Status:** Draft v0.1 — awaiting approval
**Last updated:** 2026-11-15
**Owner:** Product + Engineering

---

## 1. Product Summary

MiniDrama is a mobile-first, vertical-video streaming platform for short episodic dramas. Episodes are 60–120 seconds, consumed in a full-screen 9:16 feed, organised as Dramas → Seasons → Episodes.

Launch market is India, launch content language is Tamil, with Telugu, Hindi, Malayalam, Kannada and English to follow.

**Positioning:** binge-length vertical dramas in your language, free to start and cheap to continue.

---

## 2. Scope Boundaries

| In scope for v1.0 | Out of scope for v1.0 |
|---|---|
| Android mobile app (Expo / React Native) | iOS release (build kept compiling, not shipped) |
| Admin web dashboard | Creator self-serve upload portal |
| Vertical player, watch history, favourites, search | Social feed, comments, user-to-user features |
| Free + premium content gating | Live streaming, offline downloads |
| Google Play Billing monetisation | Web consumer app, TV apps |
| Tamil content, Tamil + English UI | Full UI localisation in all six languages |

**Why Android-first:** the launch audience is overwhelmingly Android in India, and Play Billing plus rewarded ads give a monetisation path that does not depend on Apple review cycles during early iteration. iOS is a Stage 8+ decision, but the codebase stays iOS-compatible throughout.

---

## 3. Personas

**P1 — The commuter (primary).** 18–30, Tamil-speaking, mid-range Android, 4G, watches in 10–20 minute sessions. Wants to be watching within seconds of opening the app and never think about navigation.

**P2 — The binge viewer.** Has found a drama she likes, will watch 30+ episodes in a sitting, will pay to keep going if the price is low and the flow is frictionless.

**P3 — The browser.** Opens the app with no specific intent. Needs strong discovery: trending, genre rails, a convincing featured banner.

**P4 — The content operator (internal).** Uploads and schedules episodes, sets access and pricing, monitors processing and performance. Non-technical — the admin UI must never expose Mux internals.

---

## 4. Functional Requirements

Requirement IDs are stable and are referenced by DEVELOPMENT_ROADMAP.md and the test plan.

### 4.1 Authentication & Identity

| ID | Requirement | Priority |
|---|---|---|
| AUTH-01 | Splash resolves auth state and routes within 1.5s on cold start | P0 |
| AUTH-02 | Onboarding: language selection and genre preferences, skippable | P1 |
| AUTH-03 | Guest browsing — full discovery and playback of free episodes with no account | P0 |
| AUTH-04 | Google Sign-In | P0 |
| AUTH-05 | Phone (OTP) sign-in | P0 |
| AUTH-06 | Guest → registered merge preserves watch history and favourites | P0 |
| AUTH-07 | Silent session refresh; expired session handled without data loss | P0 |
| AUTH-08 | Logout clears all local credential and user state | P0 |
| AUTH-09 | In-app account deletion plus a public web deletion-request URL (Play requirement) | P0 |

### 4.2 Discovery

| ID | Requirement | Priority |
|---|---|---|
| DISC-01 | Home featured banner — hero drama, muted trailer autoplay | P0 |
| DISC-02 | Rails: Trending, Recently Released, Continue Watching, Recommended, New Episodes | P0 |
| DISC-03 | Category / genre browse | P0 |
| DISC-04 | Content-language filter, persisted to profile | P0 |
| DISC-05 | Server-side title search with client debounce | P0 |
| DISC-06 | Search filters: genre, language | P1 |
| DISC-07 | Trending searches shown on empty query | P2 |
| DISC-08 | Recommendations — v1 is rule-based: same genre/language, popularity-weighted, excludes completed | P1 |

**Explicit non-goal for v1:** ML personalisation. The rule-based recommender is the deliverable; the API shape is designed so the implementation can be swapped with no client change.

### 4.3 Drama Detail

| ID | Requirement | Priority |
|---|---|---|
| DD-01 | Poster, title, synopsis, genre chips, language, episode count, content rating | P0 |
| DD-02 | Cast list | P1 |
| DD-03 | Trailer playback | P1 |
| DD-04 | Paginated episode list showing watched / locked / current state per episode | P0 |
| DD-05 | Primary CTA resolves to "Start watching" or "Resume Ep N" | P0 |
| DD-06 | Add / remove favourite | P0 |

### 4.4 Player — highest risk, highest value

| ID | Requirement | Priority |
|---|---|---|
| PLY-01 | Full-screen vertical 9:16 HLS playback | P0 |
| PLY-02 | Vertical swipe between episodes within a season | P0 |
| PLY-03 | Next episode prewarmed before the current one ends | P0 |
| PLY-04 | Time to first frame < 1.5s on 4G, p75 | P0 |
| PLY-05 | Tap to play/pause; scrub bar with seek | P0 |
| PLY-06 | Auto-advance to next episode, disableable in settings | P0 |
| PLY-07 | Subtitle track selection and rendering | P1 |
| PLY-08 | Playback position reported on heartbeat and on exit | P0 |
| PLY-09 | Like, favourite, share, report from the player overlay | P1 |
| PLY-10 | Network loss → clear retry state, resumes at last position on reconnect | P0 |
| PLY-11 | Adaptive bitrate; never downloads the whole asset before playback | P0 |
| PLY-12 | Players released on unmount; bounded instance pool in the feed | P0 |
| PLY-13 | Background playback disabled by default | P0 |
| PLY-14 | Locked episode shows the unlock sheet instead of playback | P0 |

### 4.5 Watch History & Library

| ID | Requirement | Priority |
|---|---|---|
| HIST-01 | Last-watched episode and position per drama, server-persisted | P0 |
| HIST-02 | Resume from stored position within ±2s | P0 |
| HIST-03 | Episode marked complete at ≥90% watched | P0 |
| HIST-04 | Continue Watching ordered by recency; finished dramas drop off | P0 |
| HIST-05 | Favourites add/remove, account-synced, listed in profile | P0 |
| HIST-06 | History writes queued offline and flushed on reconnect | P1 |

### 4.6 Monetisation

| ID | Requirement | Priority |
|---|---|---|
| MON-01 | Every episode carries an access type: free or premium | P0 |
| MON-02 | Entitlement evaluated server-side on every playback authorisation | P0 |
| MON-03 | Subscription purchase via Google Play Billing | P0 |
| MON-04 | Server-side purchase verification via the Play Developer API | P0 |
| MON-05 | Subscription lifecycle (renew, cancel, grace, hold, refund) driven by Play RTDN | P0 |
| MON-06 | Rewarded-ad unlock of a single episode | P1 |
| MON-07 | Coin wallet and per-episode unlock | **DECISION PENDING — §7 PD-1** |
| MON-08 | Restore purchases | P0 |

### 4.7 Admin Dashboard

| ID | Requirement | Priority |
|---|---|---|
| ADM-01 | Admin login in a credential space separate from consumer accounts | P0 |
| ADM-02 | RBAC: SuperAdmin / ContentManager / Moderator / Analyst | P0 |
| ADM-03 | Drama CRUD, poster and cover upload, publish/unpublish, archive | P0 |
| ADM-04 | Season CRUD | P0 |
| ADM-05 | Episode CRUD with Mux direct upload and live processing status | P0 |
| ADM-06 | Subtitle upload per episode per language | P1 |
| ADM-07 | Scheduled publication at a future timestamp | P1 |
| ADM-08 | In-dashboard video preview | P1 |
| ADM-09 | User list, search, account-status management | P0 |
| ADM-10 | Content-report queue with resolve / dismiss actions | P1 |
| ADM-11 | Analytics: views, unique viewers, avg watch duration, completion %, retention | P1 |
| ADM-12 | Audit log of every destructive and publish action | P0 |

### 4.8 Notifications

| ID | Requirement | Priority |
|---|---|---|
| NOT-01 | Push-token registration per device | P1 |
| NOT-02 | New-episode notification to users who favourited the drama | P1 |
| NOT-03 | Per-user notification preferences and OS permission handling | P1 |

---

## 5. Non-Functional Requirements

| Area | Target |
|---|---|
| Cold start to interactive home | < 2.5s on a 2023 mid-range Android, p75 |
| Time to first video frame | < 1.5s on 4G, p75 |
| Rebuffer ratio | < 1% of watch time |
| API p95 latency | < 300ms for read endpoints |
| Crash-free sessions | > 99.5% |
| Playback failure rate | < 0.5% of playback attempts |
| Android download size | < 60 MB |
| Availability | 99.5% monthly on the playback-authorisation path |

**Accessibility:** 44×44dp minimum touch targets, 4.5:1 text contrast on every surface, dynamic type to 130%, screen-reader labels on all interactive controls.

**Privacy and compliance:**

- **DPDP Act 2023 (India)** — consent capture, purpose limitation, deletion on request.
- **IT Rules 2021, Part III** — applies to OTT curated-content publishers: per-title age classification, content descriptors, a named grievance officer and a grievance-redressal workflow. **This is a launch blocker and is not currently covered in CLAUDE.md — see §7 PD-5 and the risk register.**
- **Google Play Data Safety** declaration must match what is actually collected.

---

## 6. Success Metrics

| Metric | v1 target |
|---|---|
| D1 / D7 retention | 35% / 15% |
| Episodes per session | ≥ 6 |
| Session length | ≥ 12 min |
| Drama start → episode 5 conversion | ≥ 25% |
| Free → paying conversion | ≥ 2% of MAU |
| Playback start success | ≥ 99.5% |

---

## 7. Open Product Decisions

Each of these blocks a specific downstream artefact. Recommendations are mine; the call is yours.

| # | Decision | Options | Blocks | Recommendation |
|---|---|---|---|---|
| PD-1 | Monetisation model | (a) subscription only (b) coin wallet + per-episode unlock (c) both | DB schema, Stage 7 | **(c), shipped a → b.** Subscription is faster to ship and verify; the coin model is what actually converts in this category. Model the schema for both now so (b) is not a migration event. |
| PD-2 | Pricing granularity | Flat coins per episode / per drama / first-N-free | Schema, admin UI | First-N-free configurable per drama, plus a flat coin price. Simplest to operate, matches the category. |
| PD-3 | Rewarded-ad network | AdMob vs none in v1 | Stage 7 | AdMob — but it is not in the CLAUDE.md stack, so it needs explicit approval to add. |
| PD-4 | Content language strategy | One drama row per language vs a translation table | Schema — expensive to change later | Translation table. Supports dubbed and subbed variants of one title without splitting its analytics. |
| PD-5 | Age-rating scheme | Self-defined vs IT-Rules-aligned (U, U/A 7+, 13+, 16+, A) | Compliance, admin UI | IT-Rules-aligned. Mandatory for an Indian OTT publisher and free to adopt now. |
| PD-6 | Guest identity | Device-local only vs anonymous server account | AUTH-06, schema | Anonymous server account. Makes the merge trivial and gives real guest analytics. |
| PD-7 | Launch content volume | How many dramas × episodes at launch? | Mux cost model, infra sizing | Needs a number from Product — every cost projection depends on it. |

---

## 8. Assumptions

1. All content is licensed or originally produced. No asset comes from a reference application.
2. Episodes are pre-produced files uploaded by internal operators; there is no UGC pipeline in v1.
3. Average episode length is 90 seconds; a season runs 40–80 episodes.
4. Launch traffic is modelled at 50k MAU, with infrastructure chosen to reach 10× that without re-architecture.

Assumptions 3 and 4 drive the video cost model and the Postgres sizing. If either is materially wrong, revisit PD-7 and the video-provider decision in SYSTEM_ARCHITECTURE.md §9.
