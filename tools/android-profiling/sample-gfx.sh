#!/usr/bin/env bash
# Reads frame statistics for the app: total frames, janky frames, and the
# frame-time percentiles Android itself reports.
#
# Dropped frames are not observable from JavaScript. This is the measurement.
#
# Usage:
#   tools/android-profiling/sample-gfx.sh reset    # before the run
#   tools/android-profiling/sample-gfx.sh report   # after the run

set -euo pipefail

PACKAGE="${PACKAGE:-host.exp.exponent}"   # Expo Go. For a dev build: app.minidrama.mobile
ACTION="${1:-report}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found on PATH. Install Android platform-tools."
  exit 1
fi

case "$ACTION" in
  reset)
    adb shell dumpsys gfxinfo "$PACKAGE" reset > /dev/null
    echo "Frame counters reset for $PACKAGE. Start the run now."
    ;;
  report)
    echo "Frame statistics for $PACKAGE"
    echo
    adb shell dumpsys gfxinfo "$PACKAGE" \
      | grep -E "Total frames rendered|Janky frames|50th percentile|90th percentile|95th percentile|99th percentile|Number Missed Vsync|Number High input latency|Number Slow UI thread|Number Slow bitmap uploads|Number Slow issue draw commands" \
      || echo "No frame statistics returned. Is the app in the foreground?"
    ;;
  *)
    echo "Usage: $0 [reset|report]"
    exit 1
    ;;
esac
