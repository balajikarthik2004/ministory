-- CreateEnum
CREATE TYPE "PlaybackEventType" AS ENUM ('playback_started', 'playback_paused', 'playback_resumed', 'playback_progress', 'playback_completed', 'playback_failed', 'episode_changed', 'playback_abandoned');

-- CreateTable
CREATE TABLE "PlaybackEvent" (
    "eventId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "dramaId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "type" "PlaybackEventType" NOT NULL,
    "positionSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationSec" DOUBLE PRECISION,
    "errorCode" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,

    CONSTRAINT "PlaybackEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE INDEX "PlaybackEvent_episodeId_occurredAt_idx" ON "PlaybackEvent"("episodeId", "occurredAt");

-- CreateIndex
CREATE INDEX "PlaybackEvent_dramaId_occurredAt_idx" ON "PlaybackEvent"("dramaId", "occurredAt");

-- CreateIndex
CREATE INDEX "PlaybackEvent_sessionId_idx" ON "PlaybackEvent"("sessionId");

-- CreateIndex
CREATE INDEX "PlaybackEvent_receivedAt_idx" ON "PlaybackEvent"("receivedAt");
