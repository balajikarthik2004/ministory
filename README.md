# MiniDrama

Short-form vertical drama streaming platform — Expo mobile app, React admin dashboard, Node/Express API.

**Status:** Milestone 1.1 (project foundation) complete. No product features are implemented yet.

---

## Requirements

| Tool                       | Version    | Notes                                      |
| -------------------------- | ---------- | ------------------------------------------ |
| Node.js                    | ≥ 22       | Developed on 24.15.0                       |
| pnpm                       | ≥ 10       | `corepack enable pnpm`, or `npm i -g pnpm` |
| Git                        | any recent |                                            |
| Android device or emulator | Android 8+ | For the mobile app                         |

A database is **not** required yet — it arrives in Milestone 1.3.

---

## Setup

```bash
pnpm install

cp apps/backend/.env.example apps/backend/.env
cp apps/admin/.env.example   apps/admin/.env.local
cp apps/mobile/.env.example  apps/mobile/.env
```

The defaults in each `.env.example` work for local development as-is. `.env` files are gitignored and must never be committed.

---

## Running

Each app runs independently, in its own terminal.

| App     | Command            | URL                            |
| ------- | ------------------ | ------------------------------ |
| Backend | `pnpm dev:backend` | http://localhost:4000          |
| Admin   | `pnpm dev:admin`   | http://localhost:5173          |
| Mobile  | `pnpm dev:mobile`  | Metro on http://localhost:8081 |

Equivalent long form, if you prefer running from the app directory:

```bash
pnpm --filter @minidrama/backend dev     # tsx watch, restarts on change
pnpm --filter @minidrama/admin dev       # vite
pnpm --filter @minidrama/mobile start    # expo start
```

Check the API is up:

```bash
curl http://localhost:4000/health
curl http://localhost:4000/api/v1/health
```

---

## Running the mobile app on a physical Android device

Both your computer and your phone must be on the same Wi-Fi network.

1. **Install Expo Go** from the Play Store (it must match SDK 58).
2. **Start the bundler:**
   ```bash
   pnpm dev:mobile
   ```
3. **Scan the QR code** printed in the terminal with Expo Go.

If the QR code does not connect, your network is probably blocking the LAN connection (common on corporate and guest Wi-Fi). Two fallbacks:

```bash
# Tunnel through Expo's relay - slower, works on almost any network
pnpm --filter @minidrama/mobile start -- --tunnel

# Or go over USB with adb reverse
adb reverse tcp:8081 tcp:8081
pnpm --filter @minidrama/mobile start -- --localhost
```

**Pointing the app at your API.** `apps/mobile/.env` defaults to `http://10.0.2.2:4000`, which is how the **Android emulator** reaches your machine. A **physical device** needs your computer's LAN IP:

```bash
# Find your IPv4 address
ipconfig | findstr IPv4

# Then in apps/mobile/.env
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.42:4000/api/v1
```

Start the backend with `HOST=0.0.0.0` (the default) so it accepts connections from the device, and allow port 4000 through Windows Firewall for private networks.

> Nothing in the app calls the API yet — this configuration matters from Milestone 3 onward.

A development build (`npx expo run:android`) is only needed once a native module that Expo Go does not bundle is added. That happens in Milestone 2 with `expo-video`.

---

## Repository layout

```
minidrama/
├── apps/
│   ├── mobile/      Expo + React Native + Expo Router
│   ├── admin/       React + Vite + Tailwind v4
│   └── backend/     Node + Express, modular monolith
├── packages/
│   ├── contracts/   Zod schemas + inferred types - the API contract
│   ├── config/      Shared ESLint and Prettier configuration
│   └── ui-tokens/   Design tokens for both clients
└── docs/            Architecture, schema, API, UI and roadmap
```

Dependency rule: `apps/*` may depend on `packages/*`; `packages/*` never depend on `apps/*`; no app imports another app.

---

## Workspace commands

Run from the repository root. Turborepo handles ordering and caching.

```bash
pnpm build        # build packages, then the admin bundle and backend dist
pnpm typecheck    # tsc --noEmit across all six packages
pnpm lint         # eslint across all six packages
pnpm format       # prettier --write
pnpm clean        # remove build output and node_modules
```

---

## Documentation

| Document                                                     | Contents                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| [docs/PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md) | Numbered requirements, NFR targets, open product decisions     |
| [docs/SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md)   | System design, module layout, risk register                    |
| [docs/DECISIONS.md](docs/DECISIONS.md)                       | Architecture decision records with alternatives and trade-offs |
| [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md)           | Prisma schema, indexes, data lifecycle                         |
| [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md)       | Endpoint contract, envelope, authorisation matrix              |
| [docs/UI_UX_GUIDELINES.md](docs/UI_UX_GUIDELINES.md)         | Design tokens, component inventory, state rules                |
| [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md)   | Milestones, exit criteria, dependency checklist                |
| [CLAUDE.md](CLAUDE.md)                                       | Project instructions and standards                             |

---

## Conventions

- **TypeScript strict everywhere.** `any` is an ESLint error.
- **No raw values in components.** Colours, spacing and type come from `@minidrama/ui-tokens`.
- **No secrets in client code.** `EXPO_PUBLIC_*` and `VITE_*` variables ship inside the bundle and are readable by anyone with the APK.
- **Module boundaries are linted.** Importing another backend module's repository is an error; go through its service.
- **The API never returns an internal error.** Every failure leaves through the central error handler with a safe message and a request ID.
