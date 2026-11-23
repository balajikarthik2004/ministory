#!/usr/bin/env bash
# Streams crashes and ExoPlayer errors during a spike run.
#
# A crash kills the process, so nothing inside the app can record it. This is
# how the crash count in docs/VIDEO_PLAYER_SPIKE.md is obtained.
#
# Usage:  tools/android-profiling/watch-crashes.sh [output_log]

set -euo pipefail

OUTPUT="${1:-crashes-$(date +%Y%m%d-%H%M%S).log}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found on PATH. Install Android platform-tools."
  exit 1
fi

echo "Clearing logcat buffer..."
adb logcat -c

echo "Watching for crashes, ANRs, OOM kills and player errors."
echo "Writing to $OUTPUT. Ctrl-C to stop."
echo

adb logcat \
  AndroidRuntime:E \
  ActivityManager:W \
  ExoPlayerImplInternal:E \
  MediaCodec:E \
  lowmemorykiller:I \
  ReactNativeJS:E \
  '*:S' \
  | tee "$OUTPUT"
