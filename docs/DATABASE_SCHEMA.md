# MiniDrama — Database Schema

**Status:** Proposal v0.1 — awaiting approval
**Engine:** PostgreSQL 16 · **ORM:** Prisma
**Last updated:** 2026-11-15

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

/// [+] ARCH §8. Raw events — partitioned by month, 90-day retention.
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

**Account deletion (AUTH-09, DPDP).** On request: hard-delete `UserProfile`, `Session`, `Device`, `Favorite`, `WatchHistory`, `DramaProgress`, `Notification`; anonymise `User` (null the identifiers, status `DELETED`, retain the id); retain `Payment` and `Subscription` with the user reference intact for the statutory financial-record period; null `PlaybackEvent.userId`. Deletion completes within 30 days and is logged in `AdminAuditLog`.

**Retention.** `PlaybackEvent` 90 days · `SearchQuery` 180 days · `Session` purged after expiry + 30 days · `AdminAuditLog` 2 years.

**Minimisation.** IP addresses are stored hashed, never raw. No precise location is collected.

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
