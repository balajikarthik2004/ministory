-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED');

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'UPLOADING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('FREE', 'PREMIUM');

-- CreateEnum
CREATE TYPE "ContentRating" AS ENUM ('U', 'UA_7', 'UA_13', 'UA_16', 'A');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('UPCOMING', 'ONGOING', 'COMPLETED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "firebaseUid" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSeenAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarKey" TEXT,
    "preferredLanguageId" TEXT,
    "preferredGenres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoplayNext" BOOLEAN NOT NULL DEFAULT true,
    "notificationsOptIn" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Language" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nativeName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Language_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iconKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Drama" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "posterKey" TEXT,
    "coverKey" TEXT,
    "trailerPlaybackId" TEXT,
    "languageId" TEXT NOT NULL,
    "contentRating" "ContentRating" NOT NULL DEFAULT 'UA_13',
    "releaseStatus" "ReleaseStatus" NOT NULL DEFAULT 'ONGOING',
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "freeEpisodeCount" INTEGER NOT NULL DEFAULT 3,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "totalEpisodes" INTEGER NOT NULL DEFAULT 0,
    "totalViews" BIGINT NOT NULL DEFAULT 0,
    "favoriteCount" INTEGER NOT NULL DEFAULT 0,
    "popularityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Drama_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DramaTranslation" (
    "id" TEXT NOT NULL,
    "dramaId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DramaTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DramaCategory" (
    "dramaId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,

    CONSTRAINT "DramaCategory_pkey" PRIMARY KEY ("dramaId","categoryId")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "dramaId" TEXT NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "videoProvider" TEXT NOT NULL DEFAULT 'local',
    "videoAssetId" TEXT,
    "videoUploadId" TEXT,
    "videoPlaybackId" TEXT,
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "processingError" TEXT,
    "durationSec" INTEGER,
    "aspectRatio" TEXT,
    "thumbnailKey" TEXT,
    "accessType" "AccessType" NOT NULL DEFAULT 'PREMIUM',
    "coinPrice" INTEGER NOT NULL DEFAULT 0,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "viewCount" BIGINT NOT NULL DEFAULT 0,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subtitle" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subtitle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "positionSec" INTEGER NOT NULL DEFAULT 0,
    "watchedSec" INTEGER NOT NULL DEFAULT 0,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "lastWatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DramaProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dramaId" TEXT NOT NULL,
    "lastEpisodeId" TEXT NOT NULL,
    "positionSec" INTEGER NOT NULL DEFAULT 0,
    "episodesWatched" INTEGER NOT NULL DEFAULT 0,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "lastWatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DramaProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Favorite" (
    "userId" TEXT NOT NULL,
    "dramaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("userId","dramaId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateIndex
CREATE INDEX "UserProfile_preferredLanguageId_idx" ON "UserProfile"("preferredLanguageId");

-- CreateIndex
CREATE UNIQUE INDEX "Language_code_key" ON "Language"("code");

-- CreateIndex
CREATE INDEX "Language_isActive_sortOrder_idx" ON "Language"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "Category_isActive_sortOrder_idx" ON "Category"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Drama_slug_key" ON "Drama"("slug");

-- CreateIndex
CREATE INDEX "Drama_status_publishedAt_idx" ON "Drama"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "Drama_languageId_status_idx" ON "Drama"("languageId", "status");

-- CreateIndex
CREATE INDEX "Drama_popularityScore_idx" ON "Drama"("popularityScore" DESC);

-- CreateIndex
CREATE INDEX "Drama_isFeatured_status_idx" ON "Drama"("isFeatured", "status");

-- CreateIndex
CREATE INDEX "DramaTranslation_languageId_idx" ON "DramaTranslation"("languageId");

-- CreateIndex
CREATE UNIQUE INDEX "DramaTranslation_dramaId_languageId_key" ON "DramaTranslation"("dramaId", "languageId");

-- CreateIndex
CREATE INDEX "DramaCategory_categoryId_idx" ON "DramaCategory"("categoryId");

-- CreateIndex
CREATE INDEX "Season_dramaId_idx" ON "Season"("dramaId");

-- CreateIndex
CREATE UNIQUE INDEX "Season_dramaId_seasonNumber_key" ON "Season"("dramaId", "seasonNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_videoAssetId_key" ON "Episode"("videoAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_videoUploadId_key" ON "Episode"("videoUploadId");

-- CreateIndex
CREATE INDEX "Episode_seasonId_episodeNumber_idx" ON "Episode"("seasonId", "episodeNumber");

-- CreateIndex
CREATE INDEX "Episode_status_publishedAt_idx" ON "Episode"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "Episode_status_scheduledAt_idx" ON "Episode"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Episode_processingStatus_idx" ON "Episode"("processingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_seasonId_episodeNumber_key" ON "Episode"("seasonId", "episodeNumber");

-- CreateIndex
CREATE INDEX "Subtitle_episodeId_idx" ON "Subtitle"("episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Subtitle_episodeId_languageId_key" ON "Subtitle"("episodeId", "languageId");

-- CreateIndex
CREATE INDEX "WatchHistory_userId_lastWatchedAt_idx" ON "WatchHistory"("userId", "lastWatchedAt" DESC);

-- CreateIndex
CREATE INDEX "WatchHistory_episodeId_idx" ON "WatchHistory"("episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchHistory_userId_episodeId_key" ON "WatchHistory"("userId", "episodeId");

-- CreateIndex
CREATE INDEX "DramaProgress_userId_isCompleted_lastWatchedAt_idx" ON "DramaProgress"("userId", "isCompleted", "lastWatchedAt" DESC);

-- CreateIndex
CREATE INDEX "DramaProgress_lastEpisodeId_idx" ON "DramaProgress"("lastEpisodeId");

-- CreateIndex
CREATE UNIQUE INDEX "DramaProgress_userId_dramaId_key" ON "DramaProgress"("userId", "dramaId");

-- CreateIndex
CREATE INDEX "Favorite_dramaId_idx" ON "Favorite"("dramaId");

-- CreateIndex
CREATE INDEX "Favorite_userId_createdAt_idx" ON "Favorite"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_preferredLanguageId_fkey" FOREIGN KEY ("preferredLanguageId") REFERENCES "Language"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drama" ADD CONSTRAINT "Drama_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "Language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DramaTranslation" ADD CONSTRAINT "DramaTranslation_dramaId_fkey" FOREIGN KEY ("dramaId") REFERENCES "Drama"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DramaTranslation" ADD CONSTRAINT "DramaTranslation_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "Language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DramaCategory" ADD CONSTRAINT "DramaCategory_dramaId_fkey" FOREIGN KEY ("dramaId") REFERENCES "Drama"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DramaCategory" ADD CONSTRAINT "DramaCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_dramaId_fkey" FOREIGN KEY ("dramaId") REFERENCES "Drama"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subtitle" ADD CONSTRAINT "Subtitle_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subtitle" ADD CONSTRAINT "Subtitle_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "Language"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchHistory" ADD CONSTRAINT "WatchHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchHistory" ADD CONSTRAINT "WatchHistory_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DramaProgress" ADD CONSTRAINT "DramaProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DramaProgress" ADD CONSTRAINT "DramaProgress_dramaId_fkey" FOREIGN KEY ("dramaId") REFERENCES "Drama"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DramaProgress" ADD CONSTRAINT "DramaProgress_lastEpisodeId_fkey" FOREIGN KEY ("lastEpisodeId") REFERENCES "Episode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_dramaId_fkey" FOREIGN KEY ("dramaId") REFERENCES "Drama"("id") ON DELETE CASCADE ON UPDATE CASCADE;
