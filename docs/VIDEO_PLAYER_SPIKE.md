# MiniDrama — M1.2 Video Player Performance Spike

**Status:** Harness complete and verified to build. **All device measurements are PENDING.**
**Last updated:** 2026-11-15

> **This is experimental code, not the production player.** Everything under
> `apps/mobile/experiments/video-player/` is throwaway. It is gated behind
> `__DEV__` and the route group redirects away in a release build.

---

## 1. Why this spike exists

Risk **R-1** in [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) is the highest-rated risk in the product: a swipe-paged vertical video feed on low-memory Android is where this product category usually fails — OOM kills, black frames on fast swipes, audio from the wrong episode. The player *is* MiniDrama; if it is bad, nothing else matters.

The spike answers one question with numbers rather than opinion: **how many simultaneous player instances should the production feed hold?**

It deliberately does not assume three is the answer.

---

## 2. Current blockers — read this first

The harness is written, type-checks, lints and bundles for Android (1,245 modules). **It has not been run**, because three free tools are missing from the development machine:

| Missing | Needed for | Install (all free / open source) |
|---|---|---|
| **FFmpeg** | Generating the HLS test fixtures. Nothing can run without video. | `winget install Gyan.FFmpeg` |
| **adb** (Android platform-tools) | Memory, dropped frames, crash capture. ~10 MB, **does not require Android Studio**. | [platform-tools](https://developer.android.com/tools/releases/platform-tools), add to PATH |
| **JDK + Android SDK** | Only for a custom dev build. See §3 — probably not needed. | Android Studio, if required |

Open a **new terminal** after installing so `PATH` refreshes.

No measurement in this document is filled in, and none will be invented. Every results cell reads `PENDING` until a real device produces a number.

---

## 3. Can this run in Expo Go?

`expo-video` ships as part of the Expo SDK, so it is expected to be available in Expo Go — meaning the spike should run on your phone **without** installing the Android SDK or building a dev build. That expectation is **unverified**; it is the first thing to find out.

**Try Expo Go first.** If the app throws a "requires a development build" error on opening an experiment, then the JDK + Android SDK install becomes necessary and `npx expo run:android` is the path.

This matters for `PACKAGE` in the profiling scripts:

| Running via | `PACKAGE` value |
|---|---|
| Expo Go | `host.exp.exponent` (the scripts' default) |
| Dev build | `app.minidrama.mobile` |

Memory numbers from Expo Go include Expo Go's own overhead and are therefore **comparative, not absolute** — valid for ranking A vs B vs C, not for judging against an absolute budget. A dev build is required before quoting an absolute memory figure.

---

## 4. Experiment architecture

```
apps/mobile/experiments/video-player/
├── types.ts                      experiment + metric types
├── fixtures.ts                   loads manifest.json, builds the playlist
├── metrics/collector.ts          the measurement engine
├── players/
│   ├── instrumented-player.ts    one VideoPlayer + its event wiring
│   └── useVideoStrategy.ts       the three strategies, behind one interface
├── components/EpisodeFeed.tsx    shared vertical pager
└── screens/ExperimentScreen.tsx  run control + results

apps/mobile/app/(experiments)/    dev-only routes
tools/video-fixtures/             FFmpeg generator + LAN static server
tools/android-profiling/          adb sampling scripts
```

**The feed is identical across all three experiments.** Only player management differs, so any difference in the numbers is attributable to the strategy and not to the list. `FlatList` is used rather than FlashList on purpose — adding a list library would introduce a second variable into a player experiment. List virtualisation is a separate M2 question.

### The three strategies

| | Players | Behaviour | Expected trade-off |
|---|---|---|---|
| **A — Single** | 1 | `player.replace(source)` on every swipe | Cheapest memory. Full load cost on every transition — expected to be the slowest. |
| **B — Dual** | 2 | Alternates by index parity; next episode preloaded paused | One extra decoder buys an instant forward swipe. Backward swipe still reloads. |
| **C — Pool** | 3 | `index % 3` rotation holding prev/current/next | Both directions instant. Three decoders is a real cost on a 4 GB device. |

In B and C, neighbours are explicitly **paused before** the incoming player starts. That ordering is the whole ballgame for audio overlap — get it backwards and two episodes play at once for a few hundred milliseconds.

C releases any player that falls outside the prev/current/next window. Without that release the pool silently grows to the length of the playlist, which is precisely the failure mode R-1 describes.

---

## 5. Test data

Five HLS streams generated locally by `tools/video-fixtures/generate.mjs`. No footage is downloaded and nothing is hosted externally (CLAUDE.md §18).

| # | Resolution | Bitrate | Duration | Audio tone |
|---|---|---|---|---|
| ep01 | 1080×1920 | 2500k | 30s | 440 Hz |
| ep02 | 720×1280 | 1200k | 45s | 554 Hz |
| ep03 | 540×960 | 800k | 20s | 659 Hz |
| ep04 | 1080×1920 | 4000k | 60s | 880 Hz |
| ep05 | 480×854 | 500k | 90s | 988 Hz |

Three deliberate properties:

- **`testsrc2` pattern with a frame counter** — a dropped or frozen frame is *visible*, not inferred.
- **A different audio tone per episode** — overlapping audio is audible as a chord. You do not have to trust the log.
- **2-second segments, VOD playlists, WebVTT subtitle rendition** — `master.m3u8` carries subtitles, `video.m3u8` does not, so subtitle handling can be measured both ways.

For runs longer than five episodes the playlist repeats the fixtures with position-suffixed IDs (`ep01#7`). Reusing a raw ID would make the pool believe the episode is already loaded and silently skip the reload the test is trying to measure.

---

## 6. What is measured, and how

### Collected automatically, in-app

| Metric | Source | Confidence |
|---|---|---|
| **Time to first frame** | `VideoView.onFirstFrameRender` — the renderer reporting a frame reached the surface | **High.** A real callback, not an inference. |
| **Transition latency** | Page settle → `onFirstFrameRender` of the new episode | High. This is the user-visible gap. |
| **Playback errors** | `statusChange` → `status === 'error'` | High |
| **Audio overlap** | Count of players reporting `playing === true` simultaneously for > 120 ms | High. 120 ms tolerance because a sub-perceptual overlap during a swap is not a defect. |
| **Stalls** | `currentTime` not advancing for > 1.5 s while `playing` | Medium. A slow network and a stall look alike — correlate with the network test. |
| **Player create/release balance** | Explicit counters | High. A non-zero balance after leaving the screen is a leak. |

### Not collectable from JavaScript

These are measured with adb. The harness does not estimate them, because an estimated memory figure is worse than no memory figure.

| Metric | Method |
|---|---|
| **Memory** | `tools/android-profiling/sample-memory.sh` — samples `dumpsys meminfo` to CSV every 5 s |
| **Dropped frames** | `tools/android-profiling/sample-gfx.sh reset` before, `report` after — `dumpsys gfxinfo` total/janky frames and percentiles |
| **Crashes** | `tools/android-profiling/watch-crashes.sh` — `logcat` filtered to AndroidRuntime, ExoPlayer, MediaCodec, lowmemorykiller |
| **Black frames** | **Manual.** Screen-record the run. The harness records the transition gap, which is *when* a black frame would appear, but cannot see the screen. |

### Known measurement limitations

1. **Transition latency starts when the page settles**, not when the finger touches the screen. The true perceived latency is slightly longer. Consistent across all three experiments, so comparisons are fair.
2. **Expo Go inflates memory** by its own runtime overhead (§3).
3. **A stall and a slow network are indistinguishable** to the harness.
4. **A crash ends the run.** Partial results are lost unless "Stop and report" was pressed — the Metro terminal log is the backup.
5. **`useExoShutter`** is left at its default. It controls whether ExoPlayer holds a black shutter until the first frame, and is a direct lever on perceived black-frame behaviour. Worth a follow-up run if black frames show up.

---

## 7. Test methodology

### Setup

```bash
# 1. Generate fixtures (once)
node tools/video-fixtures/generate.mjs

# 2. Serve them - prints the LAN URL for the phone
node tools/video-fixtures/serve.mjs

# 3. Start Metro
pnpm dev:mobile
```

On the device: open the app → **Open M1.2 player spike** → pick an experiment → paste the LAN URL → choose a mode → **Start run**.

### The runs

Each experiment (A, B, C) gets the same four runs. **Relaunch the app between runs** so each starts from a cold process.

| # | Test | Mode | What it answers |
|---|---|---|---|
| 1 | **Startup** | Manual, play episode 0 only | Cold time to first frame. Target < 1.5 s (PLY-04). |
| 2 | **30 rapid swipes** | `30 swipes` (900 ms interval) | Crashes, audio overlap, black frames, transition latency under stress. |
| 3 | **10-minute soak** | `10 min soak` | Does memory plateau or climb? |
| 4 | **Network interruption** | Manual | Turn Wi-Fi off mid-episode, wait 10 s, back on. Does it recover and resume? |

Why **900 ms** between automated swipes: fast enough to stress the pool, slow enough that a healthy implementation should keep up. Programmatic swiping removes human variance so A, B and C see identical input.

### Running with profiling

```bash
# terminal 2 - before starting the run
tools/android-profiling/sample-gfx.sh reset
tools/android-profiling/sample-memory.sh 5 results-A-soak.csv

# terminal 3
tools/android-profiling/watch-crashes.sh

# after the run
tools/android-profiling/sample-gfx.sh report
```

Results appear on screen when the run finishes, and the full event log is printed to the Metro terminal prefixed `[spike:<experiment>]`.

---

## 8. Device specifications

Captured from the device via `adb shell getprop` on 2026-11-15.

| Field | Value |
|---|---|
| Device model | OnePlus Nord CE 3 Lite (`CPH2467`) |
| Android version | 15 (SDK 35) |
| RAM | 7,562,712 kB (~7.2 GiB) |
| SoC | Qualcomm `SM6375` (Snapdragon 695 5G) |
| Screen | 1080×2400 @ 480 dpi |
| Delivery path | **USB loopback** — `adb reverse tcp:8787`, fixtures served from the dev machine |
| Running via | Expo Go 58.0.5 (versionCode 466) |
| Expo SDK | 58.0.0 |

**Two caveats that bound how far these numbers generalise:**

1. **The network is not representative.** Delivery was over USB loopback: effectively zero latency, unlimited bandwidth, no packet loss. PLY-04's "< 1.5 s on 4G, p75" target is **not** tested by this run. What was measured is player initialisation plus decode, with network cost removed. Real-world time to first frame will be higher by whatever the manifest and first-segment fetch costs on a mobile connection.
2. **7.2 GiB of RAM is not the low-memory target.** Risk R-1 concerns low-memory devices. This phone is mid-range on CPU but generous on memory, so it will not surface the OOM-kill failure mode. A 4 GB device is still needed before R-1 can be closed.

---

## 9. Results

**Experiment A measured 2026-11-15. B and C not run.**

Raw artefacts preserved in `tools/android-profiling/results/A-single/`:
`run.json` (summary + 246 events) · `memory.csv` (40 samples) · `memory-after-exit.csv` · `gfxinfo.txt` · `logcat-errors.txt` · `metro-full.log`.

### 9.1 Time to first frame

Target: **< 1.5 s p75** (PLY-04) — but see the network caveat in §8; this run does not test that target.

| Experiment | p50 | p75 | min | max | mean | n | Verdict |
|---|---|---|---|---|---|---|---|
| **A — Single** | **169 ms** | **184 ms** | 143 ms | 745 ms | 193 ms | 31 | Passes, over USB loopback only |
| B — Dual | not run | | | | | | |
| C — Pool | not run | | | | | | |

The 745 ms maximum is the first episode of the run — a cold player plus first manifest fetch. Every subsequent load sat between 143 ms and 234 ms.

### 9.2 Thirty rapid swipes

Success criteria: no crashes · no unintended audio overlap · no persistent black frames.

| Experiment | Transition p50 | p75 | max | Errors | Audio overlap | Stalls | Crashes | Janky frames |
|---|---|---|---|---|---|---|---|---|
| **A — Single** | **169 ms** | **183 ms** | 234 ms | **0** | **0** | **0** | **0** | 43 / 731 (5.88%) |
| B — Dual | not run | | | | | | | |
| C — Pool | not run | | | | | | | |

Run: 30 transitions, 31 episodes started, 28.25 s wall clock, 246 recorded events.

Frame timing (`dumpsys gfxinfo`): p50 7 ms · p90 18 ms · p95 44 ms · p99 53 ms · 6 missed vsync · 38 slow UI thread · 0 slow bitmap uploads.

`logcat` filtered to AndroidRuntime, ExoPlayerImplInternal, MediaCodec and lowmemorykiller produced **zero lines** for the whole run.

### 9.3 Memory

Success criterion: memory **stabilises** rather than climbing continuously. **Met.**

| Experiment | PSS at start | PSS peak | PSS at run end | PSS after leaving screen | Trend |
|---|---|---|---|---|---|
| **A — Single** | 336 MB | **408 MB** (t=28 s) | 400 MB | **371 MB** | Rises during loading, plateaus, then recovers |
| B — Dual | not run | | | | |
| C — Pool | not run | | | | |

The curve rises steadily for the first ~28 s (the active swipe phase), peaks at 408 MB exactly as the run ends, then flattens and drifts *down* to 400 MB over the next minute. No unbounded growth.

**This is the 30-swipe run, not the 10-minute soak.** The soak has not been run, so "stabilises over 10 minutes" is still unproven — only "stabilises over 92 seconds" is.

### 9.4 Network interruption

Not run for Experiment A. Also note it cannot be tested meaningfully over the USB loopback path — it needs a real Wi-Fi or mobile connection to interrupt.

### 9.5 Player lifecycle

| Experiment | Created | Released (as reported) | Evidence of actual release |
|---|---|---|---|
| **A — Single** | 1 | 0 | Native heap fell 181.7 → 177.6 MB and PSS 403 → 371 MB on leaving the screen, then held steady across 6 samples |
| B — Dual | not run | | |
| C — Pool | not run | | |

**The reported `1 / 0` is a harness artefact, not a leak.** `summary()` is taken inside `finish()`, while `ExperimentScreen` — and therefore the strategy hook holding the player — is still mounted. Release happens in the hook's unmount effect, which runs later. The memory evidence above confirms the release does occur. Worth correcting in the harness before B and C are run, so the figure means what it says; left alone for now because this run was not to change the implementation.

### 9.7 Wi-Fi with application-layer shaping (2026-11-15)

Experiment A re-run twice over real Wi-Fi with the fixture server shaping traffic. Raw artefacts in `tools/android-profiling/results/A-wifi/{p1,p2}/`.

#### Network path

Phone `wlan0 10.251.177.27` → PC Wi-Fi `10.251.177.203:8787`. Metro stayed on the USB tunnel (`adb reverse tcp:8081`) so the dev channel was **never shaped** and could not perturb the measurement.

**Unshaped Wi-Fi baseline**, measured from the device before shaping (`tools/android-profiling/results/A-wifi/wifi-baseline-unshaped.txt`):

| | |
|---|---|
| TTFB | 48 – 165 ms (mean ~107 ms) |
| Throughput | 1.52 – 2.01 MB/s = **12.2 – 16.1 Mbit/s** |

**All shaped figures are additive to this.** A configured 120 ms response delay sits on top of ~107 ms of real Wi-Fi latency.

#### Shaping configuration

Implemented as a shared token bucket plus a fixed pre-first-byte delay in `tools/video-fixtures/serve.mjs`. Throttling is applied progressively to streamed 16 KB chunks, with TCP backpressure respected.

| | P1 "4G constrained" | P2 "4G typical" |
|---|---|---|
| Configured bandwidth | 1.5 Mbit/s (187,500 B/s) | 5 Mbit/s (625,000 B/s) |
| **Achieved** (wall-clock, whole run) | **1.359 Mbit/s** (90.6%) | **4.503 Mbit/s** (90.1%) |
| Bytes served / requests | 13.98 MB / 108 | 24.79 MB / 129 |
| Configured response delay | 120 ms | 60 ms |
| Token-bucket burst | 46,875 B (0.25 s) | 156,250 B (0.25 s) |
| Packet loss | none — not modelled | none — not modelled |
| Jitter / reordering | none — not modelled | none — not modelled |

**Latency semantics — read this before quoting any figure.** The configured delay is an **application-layer response delay**: the server waits before writing the first byte of each HTTP response. The client observes it as added request→response time, so it contributes roughly **1× per HTTP round trip**. It is **not** physical network RTT: TCP and TLS handshakes are not delayed, and TCP's congestion-window ramp is unaffected. A real link with the same RTT would behave worse.

**The 0.25 s burst flatters TTFF.** The first 46 KB (P1) / 156 KB (P2) of every response arrives at full Wi-Fi speed before the bucket bites. Since TTFF only needs the manifest plus the start of the first segment, measured TTFF is optimistic relative to a link that is congested from the first byte.

Achieved throughput reaching ~90% of configured on both profiles means the link was saturated for most of each run — these are genuinely bandwidth-bound measurements, not idle ones.

#### Results — Experiment A across all three paths

Percentiles beyond p75 were derived from the preserved raw `first-frame` events; the harness summary emits only p50/p75 and was not modified.

| Time to first frame | USB loopback (unshaped) | **Wi-Fi P1** | **Wi-Fi P2** |
|---|---|---|---|
| min | 143 ms | 633 ms | 477 ms |
| p50 | 169 ms | **731 ms** | **561 ms** |
| p75 | 184 ms | **777 ms** | **589 ms** |
| p90 | 210 ms | 858 ms | 723 ms |
| p95 | 234 ms | **908 ms** | **759 ms** |
| max | 745 ms | 908 ms | 778 ms |
| samples | 31 | 13 | 29 |

**Both profiles meet the < 1.5 s p75 target of PLY-04** — P1 at 777 ms, P2 at 589 ms. But the headline number hides the real finding:

| | USB | **P1** | **P2** |
|---|---|---|---|
| Swipes issued | 30 | 30 | 30 |
| Swipes that rendered a frame | 30 (**100%**) | **13 (43.3%)** | 29 (**96.7%**) |
| Never rendered | 0 | **17** | 1 |
| Playback errors | 0 | 0 | 0 |
| Audio overlap | 0 | 0 | 0 |
| Stalls | 0 | 0 | 0 |
| Crashes | 0 | 0 | 0 |
| Janky frames | 43/731 (5.88%) | 46/728 (6.32%) | 51/658 (7.75%) |
| Frame p95 | 44 ms | 46 ms | 48 ms |

**Under P1, 17 of 30 swipes never produced a visible frame.** Median TTFF (731 ms) is comfortably inside the 900 ms auto-swipe interval, so this is not simple slowness: each swipe calls `player.replace()`, abandoning the in-flight load, while the 1.5 Mbit/s link is still delivering the previous episode's segments. The single player never catches up. A viewer would see black on more than half of their swipes.

At 5 Mbit/s that collapse disappears almost entirely (29/30).

**TTFF p50/p75/p95 is computed only over swipes that rendered.** For P1 that is 13 of 30, so its percentiles describe the *successful minority* and are survivorship-biased — the true user-perceived distribution is far worse than 731 ms, because 57% of swipes have no value at all.

#### Memory

| | USB | P1 | P2 |
|---|---|---|---|
| PSS min / peak | 336 / **408 MB** | 301 / **357 MB** | 314 / **364 MB** |
| PSS after leaving screen | 371 MB | — | **338 MB** |
| Native heap after exit | 177.6 MB | — | 167.7 MB |

Memory stabilised in all three. Both shaped runs peaked *lower* than USB, which is expected: less data arrived, so less was buffered. P2's native heap recovered from 174.9 MB to 167.7 MB on exit and then held flat, confirming release again.

`logcat` produced zero crash, ExoPlayer or MediaCodec lines in both runs. P1's log contained 11 `lowmemorykiller` daemon status lines reporting device-wide memory; **no process was killed** and no `Killing` line appeared.

### 9.8 Burst correction and corrected P1 baseline (2026-11-15)

Two harness defects were corrected before Experiments B and C. Both affected what earlier numbers mean.

#### Defect 1 — rate-proportional token-bucket burst

The bucket used `max(rate × 0.25, 32768)`, giving a burst proportional to the configured rate: **46,875 B at P1** and **156,250 B at P2**. That is wrong for comparing profiles — the faster profile silently received a larger head start, and since time-to-first-frame only needs the manifest plus the opening bytes of a segment, it flattered TTFF unevenly across profiles.

Now a **fixed 32,768 B** burst for every profile, overridable with `--burst`. Verified: a 722,296 B segment at P1 takes 3.815 s measured against 3.797 s predicted (0.5% error).

**Consequence: §9.7's P1 and P2 numbers are not comparable with anything produced after this change**, and not with each other on TTFF. They are retained unaltered as a record of what was run.

#### Defect 2 — lifecycle reporting

`summary()` was taken inside `finish()` while the strategy hook was still mounted, so every run reported `created / 0` regardless of whether anything was freed. The run now releases players **before** summarising. This changes only *when* an already-inevitable teardown occurs; no strategy's allocation logic was touched.

**Verified by controlled mount/unmount test:** manual run on Experiment A → video confirmed playing with HUD reporting `players 1` → "Stop and report" → results showed **`Players created / released: 1 / 1`, "All players released."** The same run exercised the stall detector, correctly reporting 3 stalls for a 2.5 Mbit/s episode on a 1.5 Mbit/s link.

Caveat: PSS did not visibly fall in the 4 s after stop (316.8 → 320.8 MB). ExoPlayer teardown is asynchronous, so the counter evidences the `release()` call; the memory figure on that timescale does not.

#### Corrected P1 baseline for Experiment A

Artefacts: `tools/android-profiling/results/A-wifi/p1-burst32k/`. Achieved throughput **1.152 Mbit/s** (76.8% of configured), 5.13 MB over 94 requests.

| | P1, 0.25 s burst (46,875 B) | **P1, 32 KB burst (corrected)** |
|---|---|---|
| TTFF min | 633 ms | 542 ms |
| TTFF p50 | 731 ms | **791 ms** |
| TTFF p75 | 777 ms | **983 ms** |
| TTFF p90 | 858 ms | 1028 ms |
| TTFF p95 | 908 ms | **1102 ms** |
| TTFF max | 908 ms | 1102 ms |
| Swipes rendering a frame | 13/30 (43.3%) | **18/30 (60.0%)** |
| Errors / overlap / stalls | 0 / 0 / 0 | 0 / 0 / 0 |
| Players created / released | 1 / 0 *(artefact)* | **1 / 1** |
| Janky frames | 46/728 (6.32%) | 47/634 (7.41%) |

TTFF rose as expected once the burst shrank — p75 +27%, p95 +21%. Still inside the 1.5 s PLY-04 target.

**Run-to-run variance is large and must be accounted for.** Render rate moved from 43.3% to 60.0% between two runs of the *same* experiment on the *same* profile. Some of that is the burst change, but 17 percentage points is far more than the burst alone plausibly explains, and bytes served differed by 2.7× (5.13 MB vs 13.98 MB) for identical nominal work. **Single runs cannot reliably separate B from C.** Any B-vs-C conclusion drawn from one run each should be treated as provisional until repeated.

### 9.9 A / B / C benchmark series — 3 runs each (2026-11-15)

Nine runs under one configuration. Artefacts: `tools/android-profiling/results/bench-p1-32k/`.

**Conditions, identical for every run:** P1 at 1.5 Mbit/s · fixed 32,768 B burst · 120 ms application-layer response delay · the same five single-variant fixtures · 30 automated swipes at 900 ms · OnePlus Nord CE 3 Lite over Wi-Fi · Metro on USB (never shaped) · cold app restart, counter reset and ~30 s cooldown before each run.

Run order was interleaved **B1 C1 A2 B2 C2 A3 B3 C3** so drift spreads across strategies instead of landing on whichever ran last. A run 1 is the corrected-burst run completed earlier, reused at the user's direction and copied with a provenance note.

#### Primary metric — visible-frame success rate

Swipes that rendered a frame *before the next swipe arrived*, out of 30.

| Strategy | Run 1 | Run 2 | Run 3 | Mean | Median | SD |
|---|---|---|---|---|---|---|
| **A — Single (1 player)** | 60.0% | 56.7% | 60.0% | **58.9%** | 60.0% | 1.9 |
| **B — Dual (2 players)** | 56.7% | 53.3% | 50.0% | **53.3%** | 53.3% | 3.3 |
| **C — Pool (3 players)** | 30.0% | 30.0% | 30.0% | **30.0%** | 30.0% | **0.0** |

#### Time to first frame (ms)

| | A — Single | B — Dual | C — Pool |
|---|---|---|---|
| p50 mean (runs) | **787** (791, 775, 794) | 1555 (1450, 1495, 1720) | 1585 (1560, 1604, 1590) |
| p75 mean | **972** (983, 949, 985) | 1830 (1676, 1950, 1863) | 1940 (1910, 1933, 1976) |
| p90 mean | **1027** (1028, 1005, 1048) | 1906 (1755, 2025, 1937) | 2080 (1986, 2055, 2200) |
| p95 mean | **1095** (1102, 1039, 1145) | 2005 (1967, 2037, 2010) | 2282 (2271, 2331, 2244) |
| min / max observed | 542 / 1145 | 1046 / 2265 | 1041 / 2331 |

**Only A stays inside the 1.5 s PLY-04 target.** B and C exceed it at p75 and beyond.

#### Everything else

| | A | B | C |
|---|---|---|---|
| Playback errors (3 runs) | 0 | 0 | 0 |
| Audio overlap | **0** | **0** | **0** |
| Stalls | 0 | 5 | 0 |
| Crashes / ANRs | 0 | 0 | 0 |
| Lifecycle balanced | ✅ 1/1 ×3 | ✅ 2/2 ×3 | ✅ 3/3 ×3 |
| PSS peak, mean | 360 MB | 369 MB | 370 MB |
| Janky frames | 6.5–7.7% | 9.3–10.2% | 7.7–8.2% |
| Achieved throughput, mean | 1.14 Mbit/s | 1.35 Mbit/s | 1.35 Mbit/s |
| Thermal | 31.6–32.0 °C across all nine runs, no throttling |

Audio overlap was zero in all nine runs, including B and C where two and three players coexist — the pause-before-play ordering holds.

#### What this shows

**On a bandwidth-constrained link, preloading is actively harmful, and more preloading is worse.** The ranking is monotonic in player count and inverted from the usual assumption: 1 player 58.9%, 2 players 53.3%, 3 players 30.0%.

The mechanism is visible in the throughput figures. A used only 1.14 Mbit/s of the 1.5 available; B and C both saturated at 1.35. The extra players did not make better use of the link — they split it. Three concurrent fetches over 1.5 Mbit/s give each roughly 500 Kbit/s, so the *current* episode is starved by the preloading of episodes the viewer may never reach. C's TTFF p95 (2282 ms) is more than double A's (1095 ms).

C's consistency is striking: exactly 9/30 on all three runs, SD 0.0. That is not noise — it is a stable structural ceiling.

This directly contradicts the hypothesis the spike was built to test, and vindicates the brief's instruction not to assume three players are better.

**Scope limit.** This holds *where bandwidth is the binding constraint*. On the unshaped USB path, A rendered 30/30 with 169 ms p50 — bandwidth was free and preloading cost nothing. B and C were never measured on that path, so this series says nothing about which strategy wins on a fast connection.

#### Honest reporting of an anomaly

**C run 1 — partial setup failure, not a playback failure.** Its server-side window was 67.3 s against the in-app run's 35.2 s: requests continued for ~32 s after the run ended (first request 09:03:27.162, last 09:04:34.320; C2 by contrast ran 09:11:47.5 → 09:12:22.9). Its frame counter also read 1546 against ~708 for C2 and C3.

Consequences, stated precisely:

- **Unreliable for C1:** achieved throughput (0.848 Mbit/s) and janky-frame percentage (5.89%), because both are averaged over a window longer than the run.
- **Unaffected for C1:** the primary metric (9/30, identical to C2 and C3) and the TTFF percentiles, which are per-event and in line with the other two runs.
- **Root cause not determined.** It did not recur. The C aggregates above use all three runs for the primary metric and TTFF; C's throughput mean is quoted from C2 and C3 only.

**Statistical caution.** Three runs per strategy is not a significance test and none is claimed. What supports the conclusion is that the gaps are large relative to the spread: A and C differ by ~29 percentage points while the largest within-strategy SD is 3.3. The A-vs-B gap (58.9% vs 53.3%) is narrower than that margin and should be treated as suggestive only.

### 9.10 ABR ladder vs single-variant — M1.3, 9 runs (2026-11-15)

§10 ended with a prediction: the 41% miss rate under P1 is a *packaging* problem, and "the next intervention is an ABR ladder, not more players." This series tests exactly that, holding the player strategy fixed at **A — single player**, the strategy M1.2 selected.

Artefacts: `tools/android-profiling/results/bench-p2-32k/`, `bench-abr-p1-32k/`, `bench-abr-p2-32k/`. Each directory carries a `README.txt`; each run carries `CONDITIONS.txt` with the fixture server's own `/health` response, so the profile and fixture set under test are evidenced per run rather than asserted.

**Conditions:** fixed 32,768 B burst · 30 automated swipes at 900 ms · Experiment A only · OnePlus Nord CE 3 Lite over Wi-Fi · Metro on USB, never shaped · cold restart, counter reset and 30 s cooldown per run. Identical to §9.9 except for the two variables under test: the fixture set (single-variant vs the four-rendition ABR ladder) and the profile (P1 1.5 Mbit/s / 120 ms, P2 5.0 Mbit/s / 60 ms).

Run order interleaved **P2₁ ABR-P1₁ ABR-P2₁ P2₂ ABR-P1₂ ABR-P2₂ P2₃ ABR-P1₃ ABR-P2₃**. Battery temperature rose monotonically 32.0 → 34.4 °C across the nine runs with no throttling reported, and the interleave spreads that drift across all three configurations.

#### Primary metric — visible-frame success rate

Swipes that rendered a frame before the next swipe arrived, out of 30. The single-variant P1 column is the §9.9 Experiment A series, unchanged, included as the baseline this is measured against.

| Configuration | Run 1 | Run 2 | Run 3 | Mean | SD |
|---|---|---|---|---|---|
| Single-variant, P1 *(§9.9 baseline)* | 60.0% | 56.7% | 60.0% | 58.9% | 1.9 |
| Single-variant, P2 | 100% | 100% | 100% | **100%** | 0.0 |
| **ABR ladder, P1** | 100% | 100% | 100% | **100%** | 0.0 |
| ABR ladder, P2 | 83.3% | 100% | 100% | 94.4% | 9.6 |

**The ABR ladder closes the gap completely on the constrained profile.** Same player, same link, same swipe cadence: 58.9% → 100%. The prediction in §10 holds, and the remedy was packaging, exactly as the pre-registered decision rule's last row anticipated.

#### Time to first frame (ms)

Computed over swipes only, using the harness's own percentile definition (`floor(fraction × n)`). Where the opening episode rendered inside the measurement window its sample is excluded here, because it follows a page load rather than a swipe.

| | Single-variant P1 *(baseline)* | Single-variant P2 | **ABR P1** | ABR P2 |
|---|---|---|---|---|
| p50 mean | 796 (813, 775, 801) | 568 (599, 554, 552) | 743 (746, 726, 756) | 689 (732, 680, 654) |
| p75 mean | 972 (983, 949, 985) | 751 (842, 708, 702) | **768** (769, 757, 778) | 748 (834, 721, 688) |
| p90 mean | 1027 | 894 | **802** | 865 |
| p95 mean | 1095 | 937 | **824** | 886 |
| min / max | 542 / 1145 | 377 / 1056 | 671 / 1011 | 478 / 1017 |

Every configuration is inside the 1.5 s p75 target of PLY-04. The interesting column is **ABR P1**: its p50 (743 ms) is *slower* than single-variant P2, but its tail is the tightest measured anywhere in this spike — p95 824 ms against 1095 ms for the single-variant baseline. The ladder trades a little median latency for a much shorter tail, which is the right trade for a swipe feed, where the tail is what the viewer experiences as a dead screen.

#### What the ladder actually did

| | ABR P1 | ABR P2 |
|---|---|---|
| Renditions offered | 360p / 480p / 720p / 1080p | same |
| Dominant rendition (time-weighted) | **480×854** (all 3 runs) | **1080×1920** (all 3 runs) |
| Achieved throughput | 0.92 Mbit/s of 1.5 available | 2.90 Mbit/s of 5.0 available |
| Bytes served, mean | 3.9 MiB | 12.2 MiB |

Adaptation worked as designed and in both directions: under P1 the player settled on 480p and used only 61% of the available link, leaving headroom instead of starving the current episode; under P2 it climbed to 1080p and spent 3.1× the bytes for it. The single-variant P2 runs moved 15.5 MiB to achieve the same 100% — so **ABR at P1 delivers the same visible-frame rate as the single-variant stream at P2 for a quarter of the bytes.**

#### Everything else

Across all nine runs: **0 playback errors, 0 stalls, 0 audio-overlap incidents, 0 crashes or ANRs**, lifecycle balanced 1 created / 1 released every time, and `logcat` clean (no AndroidRuntime, ExoPlayer, MediaCodec or lowmemorykiller lines). PSS peak 350 ± 5 MB and native heap peak 176 ± 0.5 MB, indistinguishable across configurations — **the ladder costs no memory.** Janky frames 7.0–9.3%, overlapping across configurations.

#### Honest reporting of an anomaly

**ABR P2 run 1 — 25/30, against 30/30 for runs 2 and 3.** Its achieved throughput was also lower (2.509 Mbit/s vs 3.052 and 3.153) on 119 requests against 124 and 125. The five misses (positions 6, 9, 10, 22, 23) are spread through the run rather than clustered at the start, so a warm-up explanation does not fit.

Stated precisely:

- **Root cause not determined.** It did not recur, and nothing in `logcat`, the memory trace or the thermal snapshots distinguishes this run.
- **Not excluded.** The 94.4% mean for ABR P2 includes it. Excluding it would give 100%, and there is no principled reason to exclude it.
- **It does not affect the headline.** The P1 comparison — the one this series was run to settle — is 100% across all three ABR runs against 58.9% baseline.

**Statistical caution, unchanged from §9.9.** Three runs per configuration is not a significance test and none is claimed. What carries the P1 conclusion is the size of the gap (41 percentage points) against a within-configuration SD of 0.0–1.9. The ABR-P2-vs-single-P2 difference (94.4% vs 100%) is *within* the ABR P2 spread and should not be read as a real difference.

#### What this changes

§10's recommendation stands: **A, the single player**, with the ladder as the fix for the miss rate rather than more players. The two findings compose — A was already the best strategy on a constrained link, and ABR is what makes A good enough to ship.

One scope limit carries forward. B and C were not re-run against the ladder. With ABR reducing per-episode bytes by ~4× at P1, the bandwidth contention that made preloading harmful in §9.9 is weaker, so the case against pooling is *narrower* than before, not necessarily wrong. If M2 ever wants preloading back, it needs its own measurement against the ladder, not an appeal to §9.9.

---

### 9.6 Screen recordings

Not captured. Black-frame behaviour for Experiment A is therefore **unverified** — the harness measured a 169 ms median gap between a page settling and the first frame, which is where a black frame would be visible, but nothing observed the screen. `adb shell screenrecord` on the next run would settle it.

---

## 10. Recommended production architecture

**Recommendation: adopt A — the single player — and treat the real problem as a packaging problem, not a pooling problem.**

The decision rule below was written before any measurement. Two of its rows fired together, and both point the same way:

- *"A meets the < 1.5 s target → Adopt A."* A's TTFF p95 averaged **1095 ms**, the only strategy inside the target.
- *"None meet the target → the problem is not pooling. Investigate segment duration, HLS variant selection and `bufferOptions` before adding players."* On the primary metric nothing is acceptable: **the best strategy still leaves 41% of swipes showing no frame.**

So: A wins the comparison decisively — best on visible-frame rate (58.9% vs 53.3% vs 30.0%), best on TTFF at every percentile, lowest memory, simplest code, one decoder. Pooling is not merely unjustified here; at three players it is **actively harmful**, halving the success rate.

But adopting A does not make the feed good. A 41% miss rate is a broken experience. That gap cannot be closed by player management — it is caused by single-variant fixtures at 2.5–4 Mbit/s being served over a 1.5 Mbit/s link with no lower rendition to fall back to. **The next intervention is an ABR ladder, not more players.**

A further caveat on scope: B and C were never measured on an unconstrained path. Where bandwidth is plentiful, preloading costs nothing and may well win. If MiniDrama's real audience is mostly on good connections, this conclusion should be re-tested before it hardens into architecture.

#### The pre-registered decision rule, for the record

| If the data shows | Then |
|---|---|
| C passes all criteria and memory plateaus | Adopt the three-player pool. Both swipe directions instant. |
| C's memory climbs or crashes appear, B passes | Adopt dual-player. Accept a reload on backward swipes — forward is the dominant direction in a drama feed. |
| B and C are indistinguishable on transition latency | Adopt **B**. One fewer decoder for no measurable loss. |
| A meets the < 1.5 s target | Adopt A. Simplest code, lowest memory, and the complexity of a pool is unjustified. |
| None meet the target | The problem is not pooling. Investigate segment duration, HLS variant selection and `bufferOptions` before adding players. |

That last row is the one worth taking seriously. If time to first frame is dominated by manifest and segment fetch, more player instances will not help, and the real fix is in packaging.

---

## 11. Verification status

| Check | Status |
|---|---|
| TypeScript strict typecheck | ✅ Passes |
| ESLint | ✅ Passes |
| Android Metro bundle | ✅ 1,245 modules export cleanly |
| FFmpeg fixture generation | ✅ 5 streams, 123 segments, all probe clean (h264 + aac, exact durations) |
| `expo-video` in Expo Go | ✅ **Works.** No development build needed for the spike. |
| Experiment A device run | ✅ Completed on OnePlus Nord CE 3 Lite |
| Experiments B and C | ⬜ Not run — out of scope for this session |
| 10-minute soak, network interruption, screen recording | ⬜ Not run |

Two real API errors were caught by typecheck while building this and are worth recording, because both would have produced wrong measurements rather than obvious failures:

1. `VideoViewProps` has no `allowsFullscreen` — it is `fullscreenOptions`.
2. **`VideoView` exposes `onFirstFrameRender`.** The harness originally approximated first-frame from the first `timeUpdate` with `currentTime > 0`, which is systematically late. It now uses the real callback. Had this not been found, every time-to-first-frame figure would have been inflated by up to a tick interval.

---

## 12. Next actions

1. Install FFmpeg and adb (§2).
2. Generate fixtures, start the server, confirm the spike opens in Expo Go (§3).
3. Fill in §8 device specifications.
4. Run the four tests for A, B and C — twelve runs, roughly 45 minutes including soaks.
5. Fill in §9 and write §10 against the decision rule.

Then M1.2 is complete and M2 can build the production player against an answer instead of a guess.
