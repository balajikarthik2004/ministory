Benchmark series: Experiments A / B / C under the corrected P1 profile.

Configuration (identical for every run):
  bandwidth            1.5 Mbit/s (187,500 B/s), shared token bucket
  burst                32,768 bytes, FIXED (not rate-proportional)
  response delay       120 ms, application-layer, NOT physical RTT
  fixtures             the same five generated HLS streams, single-variant
  swipes               30 automated, 900 ms interval
  device               OnePlus Nord CE 3 Lite (CPH2467), Android 15
  delivery             Wi-Fi 10.251.177.27 -> 10.251.177.203:8787
                       Metro on USB (adb reverse tcp:8081), never shaped

Run order was interleaved (B1 C1 A2 B2 C2 A3 B3 C3) to spread any
systematic drift (thermal, cache, network) across all three strategies
rather than concentrating it in whichever ran last.

NOT COMPARABLE with this series:
  ../A-single/            USB loopback, unshaped
  ../A-wifi/p1/           old 0.25 s burst (46,875 B)
  ../A-wifi/p2/           old 0.25 s burst (156,250 B), different bandwidth
