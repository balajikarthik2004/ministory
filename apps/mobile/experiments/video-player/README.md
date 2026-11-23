# Video player spike — EXPERIMENTAL

Throwaway code for Milestone 1.2. **Not the production player.**

Full methodology, results tables and run instructions:
[docs/VIDEO_PLAYER_SPIKE.md](../../../../docs/VIDEO_PLAYER_SPIKE.md)

## Rules

- Nothing outside `experiments/` may import from here.
- Routes are gated on `__DEV__` and redirect away in a release build.
- This directory is deleted once M2 implements the real player.

## Quick start

```bash
node tools/video-fixtures/generate.mjs   # needs FFmpeg
node tools/video-fixtures/serve.mjs      # prints the LAN URL
pnpm dev:mobile
```

In the app: **Open M1.2 player spike** → choose an experiment → paste the LAN URL → **Start run**.
