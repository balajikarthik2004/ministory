#!/usr/bin/env bash
# Runs one Experiment A/B/C benchmark end to end, identically every time.
#
# Scripted rather than hand-driven so that run-to-run differences come from the
# strategy under test, not from how the operator clicked.
#
# Usage:
#   tools/android-profiling/run-experiment.sh <A|B|C> <run-dir>
#
# Preconditions (not checked here, verify once per session):
#   - fixture server running with the intended profile and --log
#   - adb reverse tcp:8081 active (Metro over USB, unshaped)
#   - device on the same Wi-Fi as the fixture server
#
# Refuses to overwrite an existing run directory.

set -euo pipefail

EXPERIMENT="${1:?usage: run-experiment.sh <A|B|C> <run-dir>}"
RUN_DIR="${2:?usage: run-experiment.sh <A|B|C> <run-dir>}"

PACKAGE="host.exp.exponent"
DEEP_LINK="exp://localhost:8081"
SHAPING_URL="http://127.0.0.1:8787"
METRO_LOG="/tmp/md-metro.log"
EXTRACTOR="${EXTRACTOR:?set EXTRACTOR to the path of extract-run.mjs}"

# Screen coordinates (1080x2400). Verified by screenshot before first use.
TAP_SPIKE_LINK="307 1175"
TAP_MODE_30="432 1436"
TAP_START="538 1668"

case "$EXPERIMENT" in
  A) TAP_CARD="538 1368" ;;
  B) TAP_CARD="538 1728" ;;
  C) TAP_CARD="538 2064" ;;
  *) echo "Unknown experiment: $EXPERIMENT (expected A, B or C)" >&2; exit 1 ;;
esac

# Guard on the result file, not the directory: the fixture server needs the
# directory to exist beforehand so it can stream its per-response log into it.
if [ -e "$RUN_DIR/run.json" ]; then
  echo "REFUSING: $RUN_DIR/run.json already exists. Results are never overwritten." >&2
  exit 1
fi
mkdir -p "$RUN_DIR"

note() { echo "[$EXPERIMENT $(basename "$RUN_DIR")] $*"; }

thermal_snapshot() {
  local label="$1"
  {
    echo "--- $label ---"
    echo "battery_temp_decidegC: $(adb shell dumpsys battery 2>/dev/null | awk -F: '/temperature/{gsub(/ /,"",$2);print $2}')"
    echo "battery_level: $(adb shell dumpsys battery 2>/dev/null | awk -F: '/level/{gsub(/ /,"",$2);print $2}')"
    echo "thermal_status: $(adb shell cmd thermalservice get-current-status 2>/dev/null | tr -d '\r')"
    adb shell dumpsys thermalservice 2>/dev/null | grep -iE "Temperature\{|mStatus|Throttling" | head -8
  } >> "$RUN_DIR/thermal.txt" 2>&1
}

# ── 1. cold restart ───────────────────────────────────────────────────
note "cold restart"
adb shell am force-stop "$PACKAGE" >/dev/null 2>&1
adb shell "sleep 2" >/dev/null 2>&1
thermal_snapshot "before run (app stopped)"
adb shell am start -a android.intent.action.VIEW -d "$DEEP_LINK" "$PACKAGE" >/dev/null 2>&1
adb shell "sleep 15" >/dev/null 2>&1

# ── 2. navigate ───────────────────────────────────────────────────────
note "navigate -> experiment $EXPERIMENT, 30 swipes"
# shellcheck disable=SC2086
adb shell input tap $TAP_SPIKE_LINK >/dev/null 2>&1; adb shell "sleep 2" >/dev/null 2>&1
# shellcheck disable=SC2086
adb shell input tap $TAP_CARD       >/dev/null 2>&1; adb shell "sleep 2" >/dev/null 2>&1
# shellcheck disable=SC2086
adb shell input tap $TAP_MODE_30    >/dev/null 2>&1; adb shell "sleep 1" >/dev/null 2>&1

adb exec-out screencap -p > "$RUN_DIR/pre-run.png" 2>/dev/null || true

# ── 3. reset counters ─────────────────────────────────────────────────
note "reset counters"
adb shell dumpsys gfxinfo "$PACKAGE" reset >/dev/null 2>&1
adb logcat -c >/dev/null 2>&1
curl -s "$SHAPING_URL/shaping/reset" >/dev/null

# ── 4. run + sample memory ────────────────────────────────────────────
note "start run"
echo "sample,elapsed_s,pss_total_kb,java_heap_kb,native_heap_kb,graphics_kb" > "$RUN_DIR/memory.csv"
# shellcheck disable=SC2086
adb shell input tap $TAP_START >/dev/null 2>&1

START=$(date +%s)
for i in $(seq 1 42); do
  NOW=$(date +%s); EL=$((NOW - START))
  D=$(adb shell dumpsys meminfo "$PACKAGE" 2>/dev/null || true)
  P=$(echo "$D" | awk '/TOTAL PSS:/{print $3;exit}')
  J=$(echo "$D" | awk '/Java Heap:/{print $3;exit}')
  N=$(echo "$D" | awk '/Native Heap:/{print $3;exit}')
  G=$(echo "$D" | awk '/Graphics:/{print $2;exit}')
  echo "$i,$EL,${P:-},${J:-},${N:-},${G:-}" >> "$RUN_DIR/memory.csv"
  adb shell "sleep 1" >/dev/null 2>&1
done
note "run window complete"

# ── 5. collect ────────────────────────────────────────────────────────
note "collect"
curl -s "$SHAPING_URL/shaping" > "$RUN_DIR/shaping.json"

adb shell dumpsys gfxinfo "$PACKAGE" 2>/dev/null \
  | grep -E "Total frames rendered|Janky frames|percentile|Number Missed Vsync|Number Slow|Number High input" \
  > "$RUN_DIR/gfxinfo.txt" || true

adb logcat -d AndroidRuntime:E ExoPlayerImplInternal:E MediaCodec:E \
  lowmemorykiller:I ActivityManager:E ReactNativeJS:E '*:S' \
  > "$RUN_DIR/logcat-errors.txt" 2>&1 || true

adb exec-out screencap -p > "$RUN_DIR/post-run.png" 2>/dev/null || true

cp "$METRO_LOG" "$RUN_DIR/metro-full.log"
node "$EXTRACTOR" "$RUN_DIR/metro-full.log" "[spike:${EXPERIMENT}-$(
  case "$EXPERIMENT" in A) echo single ;; B) echo dual ;; C) echo pool ;; esac
)]" "$RUN_DIR/run.json" > "$RUN_DIR/extract.txt" 2>&1 \
  || note "WARNING: could not extract run.json - see extract.txt"

thermal_snapshot "after run"

note "done -> $RUN_DIR"
