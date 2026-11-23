# MiniDrama — Database Schema

**Status:** v0.2 — §3 is the approved target. 13 of its models are implemented and migrated; the rest are scheduled. See §9.
**Engine:** PostgreSQL 16 · **ORM:** Prisma 7.10.1 (driver adapter `@prisma/adapter-pg`)
**Last updated:** 2026-11-15 (M1.3)

Models marked **[+]** are additions beyond the entity list in CLAUDE.md §8 and need approval. Each one states why it exists.

---

## 1. Design Rules

1. **IDs** — `cuid()` everywhere. Sequential integers leak catalogue size and invite enumeration of content URLs.
2. **Timestamps** — every table has `createdAt` and `updatedAt`. All timestamps are `timestamptz` and stored in UTC; formatting is a presentation concern.
3. **Deletes** — content is soft-deleted (`archivedAt`) so analytics history survives. Personal data under an account-deletion request is hard-deleted; see §6.
4. **Money** — `Decimal(10,2)` with an explicit ISO-4217 `currency`. Never floats.
5. **No video binaries in Postgres** (CLAUDE.md §8) — only Mux asset/playback identifiers and R2 object keys.
6. **Every foreign key gets an index.** Postgres does not create them for you, and the omission shows up as a table scan on your busiest join.
7. **Enums over lookup tables** for fixed, code-coupled value sets (status, access type). Real tables for operator-editable data (Category, Language).

---

## 2. Entity Relationship Overview

```
AdminUser ──< AdminAuditLog

User ─1:1─ UserProfile
  ├──< Device
  ├──< Session
  ├──< WatchHistory >── Episode
  ├──< DramaProgress >── Drama
  ├──< Favorite >── Drama
  ├──< Subscription >── SubscriptionPlan
  ├──< Payment
  ├──< CoinWallet ──< CoinTransaction
  ├──< EpisodeUnlock >── Episode
  ├──< Notification
  ├──< ContentReport
  └──< PlaybackEvent

Language ──< Drama
Drama ──< Season ──< Episode ──< Subtitle
Drama >──< Category        (via DramaCategory)
Drama >──< CastMember      (via DramaCast)
Drama ──< DramaTranslation
Episode ──< EpisodeDailyStat
```

---

## 3. Prisma Schema (proposed)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─────────────────────────── Enums ───────────────────────────

enum AdminRole      { SUPER_ADMIN CONTENT_MANAGER MODERATOR ANALYST }
enum UserStatus     { ACTIVE SUSPENDED BANNED DELETED }
enum PublishStatus  { DRAFT SCHEDULED PUBLISHED ARCHIVED }
enum ProcessingStatus { PENDING UPLOADING PROCESSING READY FAILED }
enum AccessType     { FREE PREMIUM }
enum ContentRating  { U UA_7 UA_13 UA_16 A }   // IT Rules 2021 aligned — PRD PD-5
enum ReleaseStatus  { UPCOMING ONGOING COMPLETED }
enum SubscriptionStatus { ACTIVE GRACE ON_HOLD PAUSED CANCELLED EXPIRED }
enum PaymentStatus  { PENDING SUCCEEDED FAILED REFUNDED }
enum PaymentProvider { GOOGLE_PLAY }
enum UnlockSource   { COIN REWARDED_AD PROMO SUBSCRIPTION }
enum CoinTxnType    { PURCHASE REWARD_AD SPEND REFUND ADMIN_GRANT }
enum ReportReason   { INAPPROPRIATE COPYRIGHT MISLEADING TECHNICAL OTHER }
enum ReportStatus   { OPEN REVIEWING RESOLVED DISMISSED }
// SUPERSEDED in M2.3 — see the PlaybackEvent note below and DECISIONS.md ADR-26.
// Implemented as eight lower_snake_case values:
//   playback_started  playback_paused  playback_resumed  playback_progress
//   playback_completed  playback_failed  episode_changed  playback_abandoned
enum PlaybackEventType { START HEARTBEAT PAUSE COMPLETE ERROR }
enum NotificationType { NEW_EPISODE DRAMA_RELEASE SUBSCRIPTION SYSTEM }

// ─────────────────────── Identity & Admin ────────────────────

model User {
  id            String     @id @default(cuid())
  firebaseUid   String?    @unique
  email         String?    @unique
  phone         String?    @unique
  isAnonymous   Boolean    @default(false)
  status        UserStatus @default(ACTIVE)
  lastSeenAt    DateTime?
  deletedAt     DateTime?
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  profile       UserProfile?
  devices       Device[]
  sessions      Session[]
  watchHistory  WatchHistory[]
  dramaProgress DramaProgress[]
  favorites     Favorite[]
  subscriptions Subscription[]
  payments      Payment[]
  wallet        CoinWallet?
  unlocks       EpisodeUnlock[]
  notifications Notification[]
  reports       ContentReport[]

  @@index([status])
  @@index([createdAt])
}

model UserProfile {
  id                 String   @id @default(cuid())
  userId             String   @unique
  displayName        String?
  avatarKey          String?           // R2 object key, not a URL
  preferredLanguageId String?
  preferredGenres    String[]  @default([])
  autoplayNext       Boolean  @default(true)
  notificationsOptIn Boolean  @default(true)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  user              User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  preferredLanguage Language? @relation(fields: [preferredLanguageId], references: [id])

  @@index([preferredLanguageId])
}

/// [+] Refresh-token store. Needed for rotation and instant revocation (ARCH §6).
model Session {
  id            String   @id @default(cuid())
  userId        String
  refreshHash   String   @unique       // argon2 hash — never the raw token
  deviceId      String?
  userAgent     String?
  ipHash        String?                // hashed, not raw (DPDP minimisation)
  expiresAt     DateTime
  revokedAt     DateTime?
  createdAt     DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
}

/// [+] Push targets. NOT-01 cannot be built without a per-device token row.
model Device {
  id            String   @id @default(cuid())
  userId        String
  platform      String                  // "android" | "ios"
  pushToken     String   @unique
  appVersion    String?
  lastActiveAt  DateTime @default(now())
  createdAt     DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

/// Replaces the `Role` entity in CLAUDE.md §8 — see §5 note 1.
model AdminUser {
  id           String    @id @default(cuid())
  email        String    @unique
  passwordHash String                    // argon2id
  name         String
  role         AdminRole @default(ANALYST)
  totpSecret   String?
  isActive     Boolean   @default(true)
  lastLoginAt  DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  auditLogs      AdminAuditLog[]
  resolvedReports ContentReport[] @relation("ReportResolver")
}

/// [+] ADM-12. Who published, unpublished or deleted what, and when.
model AdminAuditLog {
  id          String   @id @default(cuid())
  adminUserId String
  action      String                  // "drama.publish", "episode.delete", …
  entityType  String
  entityId    String
  metadata    Json?
  ipHash      String?
  createdAt   DateTime @default(now())

  adminUser AdminUser @relation(fields: [adminUserId], references: [id])

  @@index([adminUserId, createdAt])
  @@index([entityType, entityId])
}

// ───────────────────────── Catalogue ─────────────────────────

model Language {
  id         String   @id @default(cuid())
  code       String   @unique            // ISO 639-1: "ta", "te", "hi"
  name       String                      // "Tamil"
  nativeName String                      // "தமிழ்"
  isActive   Boolean  @default(true)
  sortOrder  Int      @default(0)
  createdAt  DateTime @default(now())

  dramas    Drama[]
  subtitles Subtitle[]
  profiles  UserProfile[]
  translations DramaTranslation[]
}

model Category {
  id        String   @id @default(cuid())
  slug      String   @unique             // "romance", "thriller"
  name      String
  iconKey   String?
  isActive  Boolean  @default(true)
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())

  dramas DramaCategory[]
}

model Drama {
  id             String        @id @default(cuid())
  slug           String        @unique
  title          String
  description    String
  posterKey      String?                   // R2 key
  coverKey       String?
  trailerPlaybackId String?                // Mux playback id
  languageId     String
  contentRating  ContentRating @default(UA_13)
  releaseStatus  ReleaseStatus @default(ONGOING)
  status         PublishStatus @default(DRAFT)
  isFeatured     Boolean       @default(false)
  freeEpisodeCount Int         @default(3) // PRD PD-2: first N free
  publishedAt    DateTime?
  archivedAt     DateTime?
  // denormalised counters — maintained in the same transaction as the write
  totalEpisodes  Int           @default(0)
  totalViews     BigInt        @default(0)
  favoriteCount  Int           @default(0)
  popularityScore Float        @default(0) // nightly job; drives Trending
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  language     Language           @relation(fields: [languageId], references: [id])
  seasons      Season[]
  categories   DramaCategory[]
  cast         DramaCast[]
  translations DramaTranslation[]
  favorites    Favorite[]
  progress     DramaProgress[]
  reports      ContentReport[]

  @@index([status, publishedAt])
  @@index([languageId, status])
  @@index([popularityScore(sort: Desc)])
  @@index([isFeatured, status])
}

/// [+] PRD PD-4. Localised metadata without duplicating the drama or splitting its analytics.
model DramaTranslation {
  id          String   @id @default(cuid())
  dramaId     String
  languageId  String
  title       String
  description String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  drama    Drama    @relation(fields: [dramaId], references: [id], onDelete: Cascade)
  language Language @relation(fields: [languageId], references: [id])

  @@unique([dramaId, languageId])
  @@index([languageId])
}

model DramaCategory {
  dramaId    String
  categoryId String
  drama    Drama    @relation(fields: [dramaId], references: [id], onDelete: Cascade)
  category Category @relation(fields: [categoryId], references: [id], onDelete: Cascade)

  @@id([dramaId, categoryId])
  @@index([categoryId])
}

/// [+] DD-02 "cast information" as structured rows rather than free text.
model CastMember {
  id        String   @id @default(cuid())
  name      String
  photoKey  String?
  createdAt DateTime @default(now())

  dramas DramaCast[]
}

model DramaCast {
  dramaId      String
  castMemberId String
  characterName String?
  sortOrder    Int     @default(0)

  drama      Drama      @relation(fields: [dramaId], references: [id], onDelete: Cascade)
  castMember CastMember @relation(fields: [castMemberId], references: [id], onDelete: Cascade)

  @@id([dramaId, castMemberId])
  @@index([castMemberId])
}

model Season {
  id           String        @id @default(cuid())
  dramaId      String
  seasonNumber Int
  title        String?
  description  String?
  status       PublishStatus @default(DRAFT)
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  drama    Drama     @relation(fields: [dramaId], references: [id], onDelete: Cascade)
  episodes Episode[]

  @@unique([dramaId, seasonNumber])
  @@index([dramaId])
}

model Episode {
  id            String           @id @default(cuid())
  seasonId      String
  episodeNumber Int
  title         String
  description   String?
  // Mux
  muxAssetId    String?          @unique
  muxUploadId   String?          @unique
  muxPlaybackId String?                       // signed policy — never public
  processingStatus ProcessingStatus @default(PENDING)
  processingError  String?
  durationSec   Int?
  aspectRatio   String?
  thumbnailKey  String?
  // access & publishing
  accessType    AccessType    @default(PREMIUM)
  coinPrice     Int           @default(0)     // 0 when FREE — PRD PD-1/PD-2
  status        PublishStatus @default(DRAFT)
  scheduledAt   DateTime?                     // ADM-07
  publishedAt   DateTime?
  // counters
  viewCount     BigInt        @default(0)
  likeCount     Int           @default(0)
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt

  season       Season          @relation(fields: [seasonId], references: [id], onDelete: Cascade)
  subtitles    Subtitle[]
  watchHistory WatchHistory[]
  unlocks      EpisodeUnlock[]
  dailyStats   EpisodeDailyStat[]
  reports      ContentReport[]

  @@unique([seasonId, episodeNumber])
  @@index([seasonId, episodeNumber])
  @@index([status, publishedAt])
  @@index([status, scheduledAt])          // drives the scheduled-publish job
  @@index([processingStatus])             // drives the stuck-asset reconciler
}

model Subtitle {
  id         String   @id @default(cuid())
  episodeId  String
  languageId String
  label      String
  storageKey String                    // .vtt in R2, or a Mux text track id
  isDefault  Boolean  @default(false)
  createdAt  DateTime @default(now())

  episode  Episode  @relation(fields: [episodeId], references: [id], onDelete: Cascade)
  language Language @relation(fields: [languageId], references: [id])

  @@unique([episodeId, languageId])
  @@index([episodeId])
}

// ──────────────────── Engagement & History ───────────────────

model WatchHistory {
  id            String   @id @default(cuid())
  userId        String
  episodeId     String
  positionSec   Int      @default(0)
  watchedSec    Int      @default(0)    // cumulative, for completion %
  isCompleted   Boolean  @default(false)
  lastWatchedAt DateTime @default(now())
  createdAt     DateTime @default(now())

  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  episode Episode @relation(fields: [episodeId], references: [id], onDelete: Cascade)

  @@unique([userId, episodeId])
  @@index([userId, lastWatchedAt(sort: Desc)])
  @@index([episodeId])
}

/// [+] HIST-04. Continue Watching must not scan every episode row per user.
model DramaProgress {
  id             String   @id @default(cuid())
  userId         String
  dramaId        String
  lastEpisodeId  String
  positionSec    Int      @default(0)
  episodesWatched Int     @default(0)
  isCompleted    Boolean  @default(false)
  lastWatchedAt  DateTime @default(now())

  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  drama Drama @relation(fields: [dramaId], references: [id], onDelete: Cascade)

  @@unique([userId, dramaId])
  @@index([userId, isCompleted, lastWatchedAt(sort: Desc)])
}

model Favorite {
  userId    String
  dramaId   String
  createdAt DateTime @default(now())

  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  drama Drama @relation(fields: [dramaId], references: [id], onDelete: Cascade)

  @@id([userId, dramaId])
  @@index([dramaId])                 // notification fan-out reads this direction
  @@index([userId, createdAt(sort: Desc)])
}

// ────────────────────── Monetisation ─────────────────────────

/// [+] Plans belong in data, not in a constant file the admin cannot edit.
model SubscriptionPlan {
  id            String   @id @default(cuid())
  code          String   @unique          // matches the Play product id
  name          String
  durationDays  Int
  price         Decimal  @db.Decimal(10,2)
  currency      String   @default("INR")
  coinGrant     Int      @default(0)
  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())

  subscriptions Subscription[]
}

model Subscription {
  id              String             @id @default(cuid())
  userId          String
  planId          String
  status          SubscriptionStatus @default(ACTIVE)
  provider        PaymentProvider    @default(GOOGLE_PLAY)
  purchaseToken   String             @unique   // Play purchase token
  orderId         String?
  startsAt        DateTime
  expiresAt       DateTime
  autoRenewing    Boolean            @default(true)
  cancelledAt     DateTime?
  lastVerifiedAt  DateTime?                    // nightly reconciliation (R-3)
  createdAt       DateTime           @default(now())
  updatedAt       DateTime           @updatedAt

  user User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  plan SubscriptionPlan @relation(fields: [planId], references: [id])
  payments Payment[]

  @@index([userId, status])
  @@index([status, expiresAt])       // entitlement checks and the expiry sweeper
}

model Payment {
  id             String          @id @default(cuid())
  userId         String
  subscriptionId String?
  provider       PaymentProvider @default(GOOGLE_PLAY)
  providerTxnId  String          @unique
  amount         Decimal         @db.Decimal(10,2)
  currency       String          @default("INR")
  status         PaymentStatus   @default(PENDING)
  rawPayload     Json?                       // verified provider response
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt

  user         User          @relation(fields: [userId], references: [id])
  subscription Subscription? @relation(fields: [subscriptionId], references: [id])

  @@index([userId, createdAt(sort: Desc)])
  @@index([status])
}

/// [+] PRD PD-1(b). Present from migration 1 even if the coin feature ships in Stage 7.
model CoinWallet {
  id        String   @id @default(cuid())
  userId    String   @unique
  balance   Int      @default(0)
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())

  user         User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  transactions CoinTransaction[]
}

model CoinTransaction {
  id          String      @id @default(cuid())
  walletId    String
  type        CoinTxnType
  amount      Int                      // signed: credit positive, spend negative
  balanceAfter Int
  referenceId String?                  // episodeId, paymentId, adImpressionId
  idempotencyKey String   @unique      // a double-tap must not double-charge
  createdAt   DateTime    @default(now())

  wallet CoinWallet @relation(fields: [walletId], references: [id], onDelete: Cascade)

  @@index([walletId, createdAt(sort: Desc)])
}

model EpisodeUnlock {
  id        String       @id @default(cuid())
  userId    String
  episodeId String
  source    UnlockSource
  expiresAt DateTime?                  // null = permanent
  createdAt DateTime     @default(now())

  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  episode Episode @relation(fields: [episodeId], references: [id], onDelete: Cascade)

  @@unique([userId, episodeId])
  @@index([userId])
}

model Advertisement {
  id          String        @id @default(cuid())
  name        String
  placement   String                    // "episode_unlock", "home_banner"
  network     String        @default("ADMOB")
  adUnitId    String
  imageKey    String?
  targetUrl   String?
  rewardCoins Int           @default(0)
  status      PublishStatus @default(DRAFT)
  startsAt    DateTime?
  endsAt      DateTime?
  impressions BigInt        @default(0)
  clicks      BigInt        @default(0)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  @@index([status, placement])
}

// ──────────────── Notifications & Moderation ─────────────────

model Notification {
  id        String           @id @default(cuid())
  userId    String
  type      NotificationType
  title     String
  body      String
  data      Json?
  readAt    DateTime?
  sentAt    DateTime?
  createdAt DateTime         @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt(sort: Desc)])
  @@index([userId, readAt])
}

model ContentReport {
  id          String       @id @default(cuid())
  reporterId  String?                     // nullable: guests may report
  dramaId     String?
  episodeId   String?
  reason      ReportReason
  details     String?
  status      ReportStatus @default(OPEN)
  resolvedById String?
  resolvedAt  DateTime?
  resolutionNote String?
  createdAt   DateTime     @default(now())

  reporter   User?      @relation(fields: [reporterId], references: [id], onDelete: SetNull)
  drama      Drama?     @relation(fields: [dramaId], references: [id], onDelete: Cascade)
  episode    Episode?   @relation(fields: [episodeId], references: [id], onDelete: Cascade)
  resolvedBy AdminUser? @relation("ReportResolver", fields: [resolvedById], references: [id])

  @@index([status, createdAt])
  @@index([episodeId])
}

// ───────────────────────── Analytics ─────────────────────────

/// [+] ARCH §8. Raw events — 90-day retention.
///
/// SUPERSEDED in M2.3. The implemented model (apps/backend/prisma/schema.prisma)
/// differs in four ways, each forced by the client that shipped in M2.2:
///
///   * `eventId String @id` — the client's UUID is the primary key, so
///     idempotency is a database constraint rather than an application check.
///     Delivery is at-least-once (ADR-25) and retries are normal traffic.
///   * `occurredAt` (device clock) and `receivedAt` (server clock) are stored
///     separately. A device clock can be wrong or deliberately altered.
///   * `dramaId` is denormalised onto the row; every rollup groups by drama
///     and reaching it through Season would be two joins on the largest table.
///   * `deltaSec` and `quality` are absent — the client does not produce them,
///     and an always-null column looks like data.
///
/// Also carries `platform` and `appVersion`, an allow-listed context with no
/// device or personal identifier (M2.2 §2).
model PlaybackEvent {
  id         BigInt            @id @default(autoincrement())
  userId     String?
  episodeId  String
  sessionId  String
  type       PlaybackEventType
  positionSec Int              @default(0)
  deltaSec   Int               @default(0)
  quality    String?
  errorCode  String?
  createdAt  DateTime          @default(now())

  @@index([episodeId, createdAt])
  @@index([createdAt])
}

/// [+] ADM-11 reads only this. The dashboard never touches PlaybackEvent.
model EpisodeDailyStat {
  id              String   @id @default(cuid())
  episodeId       String
  date            DateTime @db.Date
  views           Int      @default(0)
  uniqueViewers   Int      @default(0)
  totalWatchSec   BigInt   @default(0)
  completions     Int      @default(0)
  avgCompletionPct Float   @default(0)

  episode Episode @relation(fields: [episodeId], references: [id], onDelete: Cascade)

  @@unique([episodeId, date])
  @@index([date])
}

/// [+] DISC-07 trending searches.
model SearchQuery {
  id        String   @id @default(cuid())
  term      String
  resultCount Int    @default(0)
  userId    String?
  createdAt DateTime @default(now())

  @@index([term])
  @@index([createdAt])
}
```

---

## 4. Index Rationale

The indexes above are not decorative. Each one backs a specific query that would otherwise scan:

| Index | Query it serves |
|---|---|
| `Drama(status, publishedAt)` | every catalogue listing |
| `Drama(popularityScore DESC)` | Trending rail |
| `Drama(languageId, status)` | language-filtered browse (DISC-04) |
| `Episode(seasonId, episodeNumber)` | paginated episode list and next-episode lookup |
| `Episode(status, scheduledAt)` | the scheduled-publish job (ADM-07) |
| `Episode(processingStatus)` | the stuck-asset reconciler (ARCH R-6) |
| `DramaProgress(userId, isCompleted, lastWatchedAt DESC)` | Continue Watching — the hottest personalised read |
| `Favorite(dramaId)` | new-episode notification fan-out (NOT-02) |
| `Subscription(status, expiresAt)` | entitlement check on every playback token |
| `EpisodeDailyStat(episodeId, date)` | all admin analytics |

Search (DISC-05) starts on a GIN trigram index over `Drama.title`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX drama_title_trgm_idx ON "Drama" USING gin (title gin_trgm_ops);
```

Postgres full-text search is sufficient to well past the launch target. Reach for a search service only when measurements say so, not in anticipation.

---

## 5. Deviations from CLAUDE.md §8

1. **`Role` is not a table.** With four fixed roles that the code branches on, a table adds a join to every authorisation check and tempts someone to edit permissions in production without a code review. It is an `AdminRole` enum on `AdminUser` instead. If customer-defined roles are ever needed, the migration is additive.
2. **Admin identity is separate from `User`.** Mixing operator accounts into the consumer table means one query bug can expose an admin flag through a consumer endpoint. Separate tables make that mistake impossible rather than unlikely.
3. **Additions** (all marked `[+]` above): `Session`, `Device`, `AdminAuditLog`, `DramaTranslation`, `CastMember`, `DramaCast`, `DramaProgress`, `SubscriptionPlan`, `CoinWallet`, `CoinTransaction`, `EpisodeUnlock`, `PlaybackEvent`, `EpisodeDailyStat`, `SearchQuery`. Each exists because a specific P0/P1 requirement cannot be built without it.

---

## 6. Data Lifecycle & Privacy

**Account deletion (AUTH-09).** Implemented in M2.6 — see §9.6 for exactly what the code does. On request: hard-delete `UserProfile`, `Session`, `VerificationToken`, `Favorite`, `WatchHistory`, `DramaProgress` (and, when they exist, `Device` and `Notification`); anonymise `User` (null the identifiers, status `DELETED`, retain the id); retain `Payment` and `Subscription` with the user reference intact (see the retention note below); null `PlaybackEvent.userId`. Recorded in `AccountDeletion`, which holds no direct identifier.

**Deletion is immediate, not scheduled.** The original "within 30 days" wording described a ceiling; M2.6 decision D1 made the whole operation synchronous, so the ceiling is satisfied with no job infrastructure (ADR-08 defers pg-boss). Only the `PlaybackEvent` de-linking runs after the transaction, and it is observable and reconcilable (ADR-49).

**Retention.** `PlaybackEvent` 90 days · `SearchQuery` 180 days · `Session` purged after expiry + 30 days · `AdminAuditLog` 2 years · `AccountDeletion` 2 years, with its receipt hash nulled after 30 days.

**Minimisation.** IP addresses are stored hashed, never raw. No precise location is collected.

**Legal basis — unverified, and separated deliberately.** This document previously attributed retention rules to the DPDP Act and to a "statutory financial-record period". **Neither has been verified by this project**, and the specific figure once quoted for financial records has been withdrawn. The technical design does not depend on them: retaining `Payment` and `Subscription` with `User.id` as their referent is required by *any* non-zero retention obligation, and erasing everything else is the defensible position whatever the eventual answer. The periods themselves need confirmation from someone qualified before M7 ships payments, and before any of this appears in a published privacy policy. See `M2.6_ACCOUNT_DELETION_DESIGN.md` §11 for the full list of flagged assumptions.

---

## 7. Transactions

These operations are all-or-nothing (CLAUDE.md §7):

- Coin spend → `EpisodeUnlock` creation → `CoinTransaction` write → wallet balance update. Guarded by `CoinTransaction.idempotencyKey`.
- Play purchase verification → `Payment` → `Subscription` upsert.
- Guest → registered merge: reassign history, progress, favourites and wallet, then mark the anonymous user `DELETED` (AUTH-06).
- Episode publish → `Episode.status` → `Drama.totalEpisodes` → notification jobs enqueued.

---

## 8. Migration Policy

Prisma Migrate, forward-only. Every migration is reviewed in its PR as SQL, not just as a schema diff. No destructive change (drop column, narrow type, add a non-null column without a default) ships in the same release as the code that stops using it: expand, deploy, backfill, contract. Migrations run against a staging branch database before production, and every migration PR states its rollback plan.

---

## 9. Implementation status (M1.3)

Migration `20261115153845_init_catalogue_identity_engagement` is the first
migration. It creates **13 tables, 6 enums, 18 foreign keys and 52 indexes**,
and applies cleanly to an empty database.

The live schema lives in `apps/backend/prisma/schema.prisma`. This document
remains the design authority; where the two disagree, one of them is a bug.

### 9.1 What is in migration 1

| Group | Models |
|---|---|
| Identity | `User`, `UserProfile` |
| Catalogue | `Language`, `Category`, `Drama`, `DramaTranslation`, `DramaCategory`, `Season`, `Episode`, `Subtitle` |
| Engagement | `WatchHistory`, `DramaProgress`, `Favorite` |

### 9.2 What is deferred, and to when

| Models | Milestone | Why not now |
|---|---|---|
| ~~`Session`~~, `VerificationToken` | ~~M3~~ **Landed in M2.5** | Migration `20261117060610_add_auth_sessions_and_verification_tokens`. See §9.3. |
| `Device` | M6 | Push targets; nothing sends a notification yet. |
| `AdminUser`, `AdminAuditLog` | M5 | No admin application exists to write to them. |
| `CastMember`, `DramaCast` | M5 | Admin content management owns cast entry. |
| `SubscriptionPlan`, `Subscription`, `Payment`, `CoinWallet`, `CoinTransaction`, `EpisodeUnlock`, `Advertisement` | M7 | Monetisation. |
| `Notification`, `ContentReport` | M6 | Engagement and moderation. |
| `PlaybackEvent`, `EpisodeDailyStat`, `SearchQuery` | M6+ | Analytics; `PlaybackEvent` also wants month partitioning, which is a migration of its own. |

### 9.3 What M2.5 added

Additive only — two enums, three nullable columns on `User`, two new tables.
No existing migration was touched.

**`User` gained** `passwordHash` (Argon2id PHC string, nullable because a
guest has none), `emailVerifiedAt`, and `tokensValidFrom` — the last being
what makes a password change invalidate access tokens already in circulation
instead of waiting out their fifteen minutes (ADR-40).

**`Session`** is the refresh-token store from §3, with three additions the
document did not anticipate:

- `familyId` groups a rotation chain, so reuse detection can revoke all of it.
- `parentId` links a session to the one it replaced, for walking a chain.
- `revokedReason` records *why*, because `REFRESH_REUSE` is a security event
  and must be distinguishable from an ordinary logout after the fact.

**`VerificationToken`** holds password-reset and email-verification tokens in
one table with a `purpose` enum. One table rather than two: the
issue/consume/expire logic is identical, and a shared table means one place
where single use is enforced. It stores the `email` the token was issued
against, so a link sent to an old address cannot verify a new one.

**`Session.refreshHash` is SHA-256, not the argon2 hash §3 specifies.** That
deviation has its own reasoning in ADR-38 — in short, a salted hash cannot be
looked up by hashing what the client presented, which would make reuse
detection impossible rather than merely slow.

**`Device` stays deferred.** §3 defines it as a push-target table and nothing
sends notifications yet. Guest sessions bind to an install through
`Session.deviceId` instead, which needs no second table.

**This is a known, deliberate deviation from ADR-10**, which says `CoinWallet`,
`CoinTransaction` and `EpisodeUnlock` should exist "from migration 1". The M1.3
brief scoped them out. The reasoning in ADR-10 was that retrofitting a wallet
onto a system holding live payment data is expensive — and there will be no
payment data before M7, so the additive migration that adds them is cheap right
up until the moment it isn't. `Episode.coinPrice` is present now so that the
per-episode pricing model is not retrofitted onto a live catalogue.

### 9.3 Deviations from §3, with reasons

**1. Episode video columns are provider-neutral.** §3 specifies `muxAssetId`,
`muxUploadId` and `muxPlaybackId`. The implementation uses `videoProvider`
(`"local"` | `"mux"`), `videoAssetId`, `videoUploadId` and `videoPlaybackId`.

CLAUDE.md §19 requires a provider-independent video abstraction and ADR-09 puts
Mux behind a `VideoProvider` interface that is not installed — development runs
on locally generated FFmpeg HLS. Columns named after one vendor would either
hold local fixture paths under a Mux name for the whole of development, or
force a rename migration the day the provider changes. The shape is unchanged;
only the names are vendor-neutral, and `videoProvider` records which vendor a
row's identifiers belong to.

**2. `DramaProgress.lastEpisodeId` is a real foreign key.** §3 declares it as a
bare `String` with no relation. It is now a relation to `Episode` with
`onDelete: Restrict`. Without the constraint, Continue Watching can resume into
an episode that no longer exists. `Restrict` rather than `Cascade` because
deleting one episode must not erase a viewer's progress through an entire
drama — it should fail loudly and make the caller decide.

**3. The entity names in the M1.3 brief map onto §3 as follows.** The brief
asked for `Genre / Category`, `DramaLanguage`, `WatchProgress` and
`UserFavorite`. This document's names won, since it is the design authority:

| Brief | Implemented as | Note |
|---|---|---|
| Genre / Category | `Category` | One model. A genre is a category here; two tables holding the same nine rows is a distinction the UI never makes. |
| DramaLanguage | `Drama.languageId` + `DramaTranslation` | PRD PD-4 decided this: one production language per drama, localised metadata in a translation table, so dubbed and subbed variants do not split a title's analytics. |
| WatchProgress | `DramaProgress` | Same model, §3's name. |
| UserFavorite | `Favorite` | Same model, §3's name. |

### 9.4 Not yet implemented from this document

- **The `pg_trgm` extension and `drama_title_trgm_idx`** (§4). Search is M6.
  Adding the extension needs a superuser connection, which is worth settling
  deliberately rather than slipping into the first migration.
- **`PlaybackEvent` monthly partitioning** (§3). Prisma does not model
  partitions; this will be raw SQL in the migration that creates the table.
- **The retention and deletion jobs** in §6. They describe behaviour, not
  schema, and need a job runner (ADR-08, deferred).

### 9.5 Counter integrity

`Drama.totalEpisodes` and `Drama.favoriteCount` are denormalised and must be
written in the same transaction as the rows they count (§7). The seed already
follows this rule, and it is the first place a future contributor is likely to
break it.

**M2.6 added the first operation that must respect it at scale.** Account
deletion removes a user's favourites in bulk, and a plain `deleteMany` would
leave every affected drama's counter permanently inflated — nothing recomputes
it. The deletion transaction reads the affected `dramaId`s first and
decrements each by one in the same transaction (`Favorite` is keyed
`(userId, dramaId)`, so every counter moves by exactly one). A test seeds two
users favouriting one drama and asserts the survivor is still counted.

Note also that **the `User` cascades never fire on deletion**, because the
`User` row is anonymised rather than dropped. That is deliberate: a cascade
would take the favourite rows and skip the counter.

---

## 10. What M2.6 added

### 10.1 `AccountDeletion`

One new table, three new enum values, in migration
`20261118045211_add_account_deletion_audit`. Additive only: two `CREATE TYPE`,
one `ALTER TYPE ... ADD VALUE`, one `CREATE TABLE`, five indexes. No column was
dropped, no existing table altered, no data rewritten.

| Field | Why |
|---|---|
| `userId` (unique) | The retained, anonymised `User.id`. One deletion per account. |
| `source` | `IN_APP` / `WEB` / `ADMIN`. Reporting only. |
| `wasAnonymous` | Guest or registered, for reporting. |
| `requestedAt`, `completedAt` | Deletion is synchronous (D1), so both are set at once. |
| `removed*` (5 counts) | How much was removed. Never what. |
| `playbackStatus` and five companions | The de-linking lifecycle — see §10.2. |
| `receiptHash` (unique), `receiptExpiresAt` | SHA-256 of the client's deletion receipt id (ADR-47). |

**It holds no direct identifier** — no email, phone, `firebaseUid`, password,
display name, token, device id, IP hash, or anything watched. A test
serialises the whole row and asserts the account's address does not appear in
it, so a column added later that quietly carries one fails on its own.

**No foreign key to `User`**, for the same reason `PlaybackEvent` has none: the
row records that an account ceased to exist and must not be removable by a
cascade from the table it describes (ADR-48).

### 10.2 The playback de-linking lifecycle

`PlaybackEvent.userId` is nulled after the deletion transaction commits,
because it is the only unbounded part of the work. The status fields exist so
an interrupted sweep is visible rather than silent:

```
PENDING ──► IN_PROGRESS ──► COMPLETED
                │
                └────────► FAILED  (playbackErrorCode, a stable code only)
```

`pnpm --filter @minidrama/backend reconcile:deletions` finishes anything that
is not `COMPLETED`, **and re-checks rows that claim `COMPLETED` against the
events themselves** — a status that lies is worse than one that is behind. It
is idempotent, takes `--dry-run` and `--prune`, and exits non-zero when
anything is left unrepaired (ADR-49).

It deliberately reports but never touches events belonging to a `DELETED` user
with **no** `AccountDeletion` row: those are guests retired by
`mergeGuestInto`, whose events were re-pointed at the account the person owns.

### 10.3 Deletion order, as implemented

Inside one `prisma.$transaction`:

1. **Gate, lock and scrub in one statement** — a conditional `updateMany` on
   `status`, which takes the row lock, makes the operation idempotent without a
   read-then-check, and nulls the identifiers in the same breath. A concurrent
   second deletion blocks here and then matches zero rows.
2. `VerificationToken`, then `Session` — hard delete.
3. `UserProfile` — `deleteMany`, so a missing profile cannot fail a deletion.
4. `Favorite` — read `dramaId`s, delete, decrement `Drama.favoriteCount`.
5. `DramaProgress`, then `WatchHistory` — hard delete.
6. `AccountDeletion` — insert, with the receipt hash if one was presented.

Then, outside the transaction: the `PlaybackEvent` sweep.
