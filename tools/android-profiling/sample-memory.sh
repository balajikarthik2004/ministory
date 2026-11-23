#!/usr/bin/env bash
# Samples app memory while a spike run is in progress.
#
# Memory is not observable from JavaScript, so it is sampled from outside the
# app. Run this in a second terminal, start the run on the device, then stop
# this with Ctrl-C when the run finishes.
#
# Usage:
#   tools/android-profiling/sample-memory.sh [interval_seconds] [output_csv]
#
# Requires adb (Android platform-tools). It does NOT require Android Studio.

set -euo pipefail

PACKAGE="${PACKAGE:-host.exp.exponent}"   # Expo Go. For a dev build: app.minidrama.mobile
INTERVAL="${1:-5}"
OUTPUT="${2:-memory-$(date +%Y%m%d-%H%M%S).csv}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found on PATH."
  echo "Install Android platform-tools (free, ~10MB, no Android Studio needed):"
  echo "  https://developer.android.com/tools/releases/platform-tools"
  exit 1
fi

if [ -z "$(adb devices | sed -n '2p' | cut -f1)" ]; then
  echo "No device connected. Enable USB debugging and run: adb devices"
  exit 1
fi

echo "package:  $PACKAGE"
echo "interval: ${INTERVAL}s"
echo "output:   $OUTPUT"
echo
echo "elapsed_s,pss_total_kb,java_heap_kb,native_heap_kb,gfx_kb"
echo "elapsed_s,pss_total_kb,java_heap_kb,native_heap_kb,gfx_kb" > "$OUTPUT"

START=$(date +%s)
trap 'echo; echo "Saved $OUTPUT"; exit 0' INT

while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))

  DUMP="$(adb shell dumpsys meminfo "$PACKAGE" 2>/dev/null || true)"

  if [ -z "$DUMP" ]; then
    echo "${ELAPSED},,,,  # process not found"
  else
    PSS=$(echo "$DUMP"        | awk '/TOTAL PSS:/ {print $3; exit}')
    [ -z "$PSS" ] && PSS=$(echo "$DUMP" | awk '/^[[:space:]]*TOTAL/ {print $2; exit}')
    JAVA=$(echo "$DUMP"       | awk '/Java Heap:/ {print $3; exit}')
    NATIVE=$(echo "$DUMP"     | awk '/Native Heap:/ {print $3; exit}')
    GFX=$(echo "$DUMP"        | awk '/Graphics:/ {print $2; exit}')

    LINE="${ELAPSED},${PSS:-},${JAVA:-},${NATIVE:-},${GFX:-}"
    echo "$LINE"
    echo "$LINE" >> "$OUTPUT"
  fi

  sleep "$INTERVAL"
done
