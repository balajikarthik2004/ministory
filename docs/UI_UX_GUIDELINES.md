# MiniDrama — UI/UX Guidelines

**Status:** Proposal v0.1 — awaiting approval
**Last updated:** 2026-11-15

A premium, cinematic, dark entertainment app. Content is the interface; chrome gets out of the way.

**Originality constraint (CLAUDE.md §9, §16.16):** ReelShort, DramaBox and modern OTT apps are studied for interaction patterns — vertical feed, rail-based discovery, episode gating. No layout, asset, icon, typeface pairing or copy is reproduced from any of them. Patterns are not protected; specific designs and assets are.

---

## 1. Design Tokens

Tokens are the single source of truth and live in `packages/ui-tokens`, consumed by both React Native and Tailwind. A hard rule: **no raw hex, px or font size appears in a component file.** If it does, the token set is missing something — fix the tokens, not the component.

### Colour

| Token | Value | Use |
|---|---|---|
| `bg.primary` | `#090A0F` | App background, player background |
| `bg.secondary` | `#151720` | Sheets, tab bar, headers |
| `bg.card` | `#1D202B` | Cards, inputs, skeletons |
| `bg.elevated` | `#262A38` | Menus, dialogs |
| `accent.primary` | `#F5B544` | Primary CTA, active states, progress fill |
| `accent.pressed` | `#D99B2E` | Pressed state |
| `accent.subtle` | `rgba(245,181,68,0.12)` | Selected chip, accent surface |
| `text.primary` | `#FFFFFF` | Titles, body |
| `text.secondary` | `#A4A8B5` | Metadata, captions |
| `text.tertiary` | `#6B7081` | Disabled, placeholder |
| `text.onAccent` | `#17120A` | Text on an amber button |
| `border.subtle` | `rgba(255,255,255,0.08)` | Dividers, card edges |
| `status.error` | `#EF4444` | Errors, destructive |
| `status.success` | `#22C55E` | Confirmation |
| `status.warning` | `#F59E0B` | Processing, caution |
| `overlay.scrim` | `rgba(9,10,15,0.72)` | Modal backdrop |
| `overlay.gradient` | `#090A0F` → `transparent` | Poster and player gradients |

**Contrast, verified.** `text.secondary` on `bg.primary` is ~8.9:1 and `text.onAccent` on `accent.primary` is ~11:1 — both pass AA comfortably. `text.tertiary` on `bg.primary` is ~4.6:1, which passes for normal text but leaves no margin: use it only for genuinely de-emphasised content, never for anything a user must read to act. Amber on dark is the one pairing in this palette that invites accessibility mistakes, so **never put `accent.primary` text on `bg.card`** — use it as a surface or an icon colour there, not as body text.

The palette is dark-only by design. A cinematic viewing app has no light mode; a forced light theme would fight every poster on the screen.

### Typography

System fonts (`SF Pro` / `Roboto`) with Noto Sans Tamil as the fallback for Tamil glyphs. No custom font download — it costs cold-start time on exactly the devices the launch audience carries.

| Token | Size / Line | Weight | Use |
|---|---|---|---|
| `display` | 32 / 38 | 700 | Featured banner title |
| `h1` | 24 / 30 | 700 | Screen titles |
| `h2` | 20 / 26 | 600 | Section headers |
| `h3` | 17 / 22 | 600 | Card titles, drama title |
| `body` | 15 / 22 | 400 | Descriptions |
| `bodyStrong` | 15 / 22 | 600 | Emphasis, buttons |
| `caption` | 13 / 18 | 400 | Metadata, episode count |
| `micro` | 11 / 14 | 500 | Badges, chips |

Tamil text renders taller than Latin at the same size. Every text container uses `minHeight` rather than a fixed height, or Tamil descenders clip — this is the single most common i18n layout bug in this kind of app.

### Spacing, radius, elevation

4px base scale: `xs 4 · sm 8 · md 12 · lg 16 · xl 24 · 2xl 32 · 3xl 48`. Screen horizontal padding is `lg` (16). Rail gutter is `md` (12).

Radius: `sm 6` (chips, badges) · `md 10` (cards, inputs) · `lg 16` (sheets, posters) · `full 999` (avatars, pills).

Elevation on dark surfaces comes from background lightness, not shadow. Shadows are near-invisible on `#090A0F` and cost render time — use `bg.card` → `bg.elevated` to signal layers.

### Motion

| Token | Duration | Curve | Use |
|---|---|---|---|
| `instant` | 100ms | ease-out | Press feedback |
| `fast` | 180ms | ease-out | Chips, toggles, fades |
| `base` | 240ms | ease-in-out | Sheets, overlays |
| `slow` | 400ms | ease-in-out | Screen transitions |

All animation runs on the Reanimated UI thread. **Never animate while video is buffering or during a feed swipe** — CLAUDE.md §13 is explicit that playback beats decoration, and a JS-thread animation during a swipe is exactly what produces a dropped frame on a mid-range device. Respect `prefers-reduced-motion`: reduce to fades.

---

## 2. Layout System

Mobile designs target a 390×844 reference frame and must hold from 360dp (small Android) to 430dp wide.

| Element | Spec |
|---|---|
| Poster | 2:3, `lg` radius, rail width 136dp |
| Hero banner | 16:9 with a bottom gradient, title overlaid in the bottom third |
| Episode thumbnail | 9:16, 96dp wide |
| Rail | horizontal FlashList, `lg` screen padding, `md` item gap |
| Tab bar | 56dp + safe area, `bg.secondary`, top hairline border |
| Minimum touch target | 44×44dp, enforced via a `hitSlop` helper |

Safe areas are honoured everywhere. The player is the exception: it draws edge-to-edge behind the status bar, with its controls inset to the safe area.

---

## 3. Screen Specifications

**Splash** — logo on `bg.primary`, no spinner for the first 800ms (a spinner that flashes reads as slower than silence). Resolves auth and routes.

**Onboarding** — three screens: language, genre preferences, sign-in prompt. Skippable from screen one, because AUTH-03 guarantees guests full access to free content and a wall here costs more installs than it earns accounts.

**Home** — featured banner, then rails. Continue Watching sits directly below the banner when it has items; it is the highest-intent element on the screen and should never be below the fold. Rails render skeletons, not spinners.

**Drama detail** — poster header with gradient, title, metadata row (language · genres · episode count · rating), description collapsed to three lines with "more", primary CTA (Start watching / Resume Ep N), favourite and share as secondary actions, then the episode grid. Locked episodes show a lock badge, not a disabled state — a lock is an invitation, a disabled control is a dead end.

**Player** — the product. Full-bleed vertical video. Controls auto-hide after 3 seconds and return on tap. Bottom overlay: title, episode number, scrub bar. Right rail: like, favourite, share, report, episodes. Vertical swipe moves between episodes with a subtle snap. A locked episode swiped into shows the unlock sheet over a blurred still rather than a black screen — the user should see what they are being offered.

**Search** — results debounced at 300ms, with recent and trending searches shown on an empty query.

**Profile** — identity header, then History, Favourites, Subscription, Language, Notifications, Settings, Privacy, and account deletion placed last and styled with `status.error`.

---

## 4. Component Inventory

Built in Stage 2 before any screen work, in `apps/mobile/components/`:

**Primitives** — `Text`, `Button` (primary/secondary/ghost/destructive × sm/md/lg), `IconButton`, `Input`, `Chip`, `Badge`, `Avatar`, `Divider`, `Sheet`, `Skeleton`, `Spinner`, `ProgressBar`.

**Composites** — `DramaCard`, `DramaRail`, `FeaturedBanner`, `EpisodeListItem`, `EpisodeGrid`, `ContinueWatchingCard`, `PlayerControls`, `UnlockSheet`, `EmptyState`, `ErrorState`, `OfflineBanner`, `SectionHeader`.

A component that hardcodes a colour, a size, or a copy string is not done.

---

## 5. State Rules — non-negotiable

Every screen that fetches data implements four states. "Not designed yet" is not one of them (CLAUDE.md §9: never ship placeholder-looking layouts).

**Loading** — skeletons shaped like the real content, never a centred spinner on a full screen. A skeleton communicates what is coming; a spinner communicates only that you are waiting.

**Empty** — icon, one-line explanation, and an action that resolves it. "No favourites yet" with a "Browse dramas" button, not a blank panel.

**Error** — human-readable cause plus a Retry button. Technical detail goes to Sentry, never to the screen (CLAUDE.md §11).

**Offline** — a persistent banner, cached content still browsable, and writes queued rather than rejected (HIST-06).

### Required copy for the states users actually hit

| Situation | Copy |
|---|---|
| Episode locked | "Unlock Episode 7 — Subscribe, use 20 coins, or watch an ad" |
| Playback failed | "Couldn't play this episode. Check your connection and try again." |
| Offline | "You're offline. Some content may not be available." |
| Empty favourites | "Nothing saved yet. Tap the heart on a drama to find it here." |
| Empty search | "No dramas match '<query>'. Try a different title or genre." |
| Video processing (admin) | "Processing — this usually takes a few minutes." |

Copy never blames the user, never shows an error code, and never says "Oops". Every error message says what happened and what to do next.

---

## 6. Admin Dashboard

Same tokens, different density. The admin is a tool, not an experience: information density beats visual flourish.

Shell is a 240px fixed sidebar, a top bar with user and environment indicator, and a content area with a max width of 1440px. Tables are 48px rows with sticky headers, server-side pagination, column sorting and a bulk-select column.

Forms label every field, show inline validation on blur, disable submit while pending, and never silently discard input. Destructive actions require typed confirmation of the entity name.

The episode upload flow deserves specific care because it is where operators spend their day: drag-and-drop with a real progress bar, a clear state machine (`Uploading → Processing → Ready` / `Failed`), a visible reason on failure and a one-click retry. **An operator must never see a Mux asset ID, a webhook status or a raw error string** — those are our abstraction leaking into someone else's job.

---

## 7. Accessibility Checklist

Verified per screen before a feature is considered done:

- [ ] Text contrast ≥ 4.5:1 (≥ 3:1 for text at 18pt+)
- [ ] Touch targets ≥ 44×44dp
- [ ] Every interactive element has an `accessibilityLabel` and a `role`
- [ ] Logical focus order; modals trap focus and restore it on close
- [ ] Dynamic type to 130% without clipping or overlap
- [ ] Reduced-motion honoured
- [ ] Information is never conveyed by colour alone (locked episodes carry a lock icon, not just a dimmer poster)
- [ ] Video controls reachable by screen reader; subtitles available where tracks exist

---

## 8. Open Design Questions

1. **Brand identity** — logo, wordmark and app icon do not exist yet. Needed before Play submission; not a blocker for Stage 2.
2. **Amber as the sole accent** — strong and distinctive, but offers no second accent for secondary CTAs or data visualisation in the admin analytics. Recommend adding one cool secondary accent for admin charts only.
3. **Player gesture grammar** — double-tap to like (feed convention) conflicts with double-tap to seek (player convention). They cannot both exist. Recommend: double-tap likes, and seeking is scrub-bar only, since episodes are 90 seconds and seek demand is low.
4. **Episode list form** — grid of numbered tiles (scales to 80 episodes) versus a list with thumbnails (richer, much longer). Recommend a numbered grid with a thumbnail only on the next-to-watch episode.
