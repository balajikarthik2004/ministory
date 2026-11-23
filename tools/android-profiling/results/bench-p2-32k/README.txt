M1.3 benchmark series: Experiment A (single player) only.
Position 2 of 3 in the interleaved ABR series run 2026-11-15.

Configuration (identical for every run in this directory):
  profile              P2 "4G typical" — 5.0 Mbit/s, 60 ms
  fixtures             single-variant (tools/video-fixtures/out)
  burst                32,768 bytes, FIXED (same as bench-p1-32k)
  response delay       application-layer, NOT physical RTT
  swipes               30 automated, 900 ms interval
  strategy             A - single player (B and C not re-run; M1.2 settled them)
  device               OnePlus Nord CE 3 Lite (CPH2467), Android 15
  delivery             Wi-Fi 10.251.177.203 -> device 10.251.177.27, port 8787
                       Metro on USB (adb reverse tcp:8081), never shaped
  per run              cold app restart, gfxinfo + logcat reset, /shaping/reset,
                       30 s cooldown before the run

Run order across the three series was interleaved:
  p2/run-01, abr-p1/run-01, abr-p2/run-01,
  p2/run-02, abr-p1/run-02, abr-p2/run-02,
  p2/run-03, abr-p1/run-03, abr-p2/run-03
so thermal and network drift spread across all three configurations rather
than landing on whichever ran last. Battery temperature rose monotonically
32.0 C -> 34.4 C across the nine runs; no throttling was reported.

Each run directory additionally carries CONDITIONS.txt, recording the fixture
server's own /health response at run time, so the profile and fixture set are
evidenced per run rather than asserted here.

COMPARABLE WITH:
  ../bench-p1-32k/A-single/   same burst, same delay semantics, same device,
                              same harness. That series is the single-variant
                              P1 baseline this one is measured against.

NOT COMPARABLE WITH:
  ../A-single/      USB loopback, unshaped
  ../A-wifi/p1/     old rate-proportional burst
  ../A-wifi/p2/     old rate-proportional burst
