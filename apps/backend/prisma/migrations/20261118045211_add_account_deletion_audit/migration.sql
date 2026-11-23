-- CreateEnum
CREATE TYPE "AccountDeletionSource" AS ENUM ('IN_APP', 'WEB', 'ADMIN');

-- CreateEnum
CREATE TYPE "PlaybackCleanupStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- AlterEnum
ALTER TYPE "VerificationPurpose" ADD VALUE 'ACCOUNT_DELETION';

-- CreateTable
CREATE TABLE "AccountDeletion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "AccountDeletionSource" NOT NULL DEFAULT 'IN_APP',
    "wasAnonymous" BOOLEAN NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "removedWatchHistory" INTEGER NOT NULL DEFAULT 0,
    "removedDramaProgress" INTEGER NOT NULL DEFAULT 0,
    "removedFavorites" INTEGER NOT NULL DEFAULT 0,
    "removedSessions" INTEGER NOT NULL DEFAULT 0,
    "removedVerificationTokens" INTEGER NOT NULL DEFAULT 0,
    "playbackStatus" "PlaybackCleanupStatus" NOT NULL DEFAULT 'PENDING',
    "playbackAnonymised" INTEGER NOT NULL DEFAULT 0,
    "playbackAttempts" INTEGER NOT NULL DEFAULT 0,
    "playbackStartedAt" TIMESTAMP(3),
    "playbackFinishedAt" TIMESTAMP(3),
    "playbackErrorCode" TEXT,
    "receiptHash" TEXT,
    "receiptExpiresAt" TIMESTAMP(3),

    CONSTRAINT "AccountDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletion_userId_key" ON "AccountDeletion"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletion_receiptHash_key" ON "AccountDeletion"("receiptHash");

-- CreateIndex
CREATE INDEX "AccountDeletion_playbackStatus_idx" ON "AccountDeletion"("playbackStatus");

-- CreateIndex
CREATE INDEX "AccountDeletion_requestedAt_idx" ON "AccountDeletion"("requestedAt");

-- CreateIndex
CREATE INDEX "AccountDeletion_receiptExpiresAt_idx" ON "AccountDeletion"("receiptExpiresAt");
