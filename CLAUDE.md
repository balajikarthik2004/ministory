# MiniDrama – Claude Code Project Instructions

## 1. Project Overview

**Project Name:** MiniDrama

**Product Type:** Short-form Drama Streaming Platform

**Vision:** Build a modern, scalable, mobile-first micro-drama streaming platform where users can discover and watch short episodic dramas in vertical video format.

The platform takes inspiration from the viewing experience of ReelShort, the regional content strategy of Indian entertainment platforms, and modern OTT applications.

We are building our own independent product. Never copy proprietary source code, branding, images, content, or protected assets from reference applications.

### Core Product Goals

- Deliver a smooth vertical drama streaming experience.
- Make discovering new dramas simple.
- Encourage users to continue watching subsequent episodes.
- Support multiple regional languages.
- Provide free and premium content experiences.
- Give administrators complete control over content.
- Build an architecture that can scale as users and video traffic increase.

---

## 2. Product Strategy

### Target Audience

Initial target market: India.

Initial audience:
- Tamil-speaking users.
- Young mobile entertainment consumers.
- Users interested in short-form stories.
- Users who prefer episodic entertainment.

Future markets:
- Telugu
- Hindi
- Malayalam
- Kannada
- English
- International audiences.

### Content Categories

- Romance
- Thriller
- Mystery
- Action
- Comedy
- Family Drama
- Fantasy
- Crime
- Horror

### Content Structure

Platform
  └── Drama
       └── Season
            └── Episodes

Each drama should support:
- Title
- Description
- Poster
- Cover image
- Trailer
- Genre
- Language
- Cast information
- Release status
- Seasons
- Episodes
- Content rating
- Premium/free classification

Each episode should support:
- Episode number
- Title
- Description
- Video URL or asset ID
- Thumbnail
- Duration
- Subtitle tracks
- Access type
- Publication status

---

## 3. Technology Stack

Use the following preferred technology stack unless a technical limitation justifies a documented alternative.

### Mobile Application

- Expo
- React Native
- TypeScript (strict mode)
- Expo Router
- expo-video
- React Native Reanimated
- Zustand for lightweight global state
- TanStack Query for server state
- React Hook Form
- Zod for validation

### Backend

- Node.js
- Express.js
- TypeScript
- PostgreSQL
- Prisma ORM
- JWT or Firebase Authentication
- REST APIs

### Admin Dashboard

- React
- Vite
- TypeScript
- Tailwind CSS
- React Router
- TanStack Query
- React Hook Form
- Zod

### Video Infrastructure

- Mux for video upload, transcoding and streaming.
- HLS adaptive bitrate playback.
- Cloudflare R2 for appropriate supporting assets.
- CDN delivery.
- Signed playback URLs or playback tokens for protected content.

### Additional Services

- Expo Notifications
- Firebase Analytics or an appropriate analytics service
- Google Play Billing for Android subscriptions and digital purchases.
- Sentry for error monitoring.

Do not introduce additional libraries without explaining why they are needed.

---

## 4. Monorepo Architecture

Organize the project as follows:

MiniDrama/
│
├── mobile/
│   ├── app/
│   ├── components/
│   ├── features/
│   ├── hooks/
│   ├── services/
│   ├── store/
│   ├── constants/
│   ├── assets/
│   ├── types/
│   └── utils/
│
├── admin/
│   └── src/
│       ├── components/
│       ├── pages/
│       ├── features/
│       ├── hooks/
│       ├── services/
│       ├── layouts/
│       ├── types/
│       └── utils/
│
├── backend/
│   └── src/
│       ├── config/
│       ├── modules/
│       ├── middleware/
│       ├── routes/
│       ├── services/
│       ├── utils/
│       ├── validators/
│       └── types/
│
├── docs/
│   ├── PRODUCT_REQUIREMENTS.md
│   ├── SYSTEM_ARCHITECTURE.md
│   ├── DATABASE_SCHEMA.md
│   ├── API_DOCUMENTATION.md
│   ├── UI_UX_GUIDELINES.md
│   └── DEVELOPMENT_ROADMAP.md
│
├── CLAUDE.md
├── README.md
└── .gitignore

Keep mobile, admin and backend independently maintainable.

Avoid unnecessary cross-module dependencies.

---

## 5. Mobile Application Features

### Authentication

- Splash screen
- Onboarding
- Guest browsing
- Google authentication
- Phone authentication
- User profile
- Logout

Guest users should be able to discover and watch publicly accessible free content.

### Home Screen

- Featured drama banner
- Trending dramas
- Recently released
- Continue watching
- Recommended for you
- Popular categories
- New episodes
- Language selection

### Drama Details

- Drama poster
- Drama title
- Description
- Genre
- Language
- Episode count
- Cast information
- Watch trailer
- Start watching
- Episode list

### Video Player

This is the most important feature of the application.

Requirements:
- Full-screen vertical video.
- 9:16 video support.
- Smooth playback.
- HLS streaming.
- Loading indicators.
- Playback error handling.
- Play/pause controls.
- Seek controls where appropriate.
- Subtitle support.
- Episode progress tracking.
- Next episode navigation.
- Auto-play next episode with user control.
- Like and favorite actions.
- Share functionality.
- Report content.
- Network failure handling.
- Background playback disabled by default.

The player must be optimized for mobile performance and low-memory devices.

Never download the entire video before playback when streaming is available.

### Watch History

- Store last watched episode.
- Store playback position.
- Resume playback.
- Track completed episodes.
- Continue watching section.

### Favorites

- Add/remove dramas.
- Saved dramas list.
- Sync favorites with user account.

### Search

- Search dramas by title.
- Search by genre.
- Filter by language.
- Trending searches.

### Profile

- User information.
- Watch history.
- Favorites.
- Language preferences.
- Subscription status.
- App settings.
- Privacy settings.
- Account deletion.

---

## 6. Admin Dashboard

Build a separate web-based administration application.

### Dashboard

Display:
- Total users
- Total dramas
- Total episodes
- Total views
- Total watch time
- Popular dramas
- Recent uploads

### Drama Management

Administrators should be able to:
- Create dramas.
- Edit dramas.
- Delete or archive dramas.
- Upload posters.
- Configure genres.
- Configure languages.
- Publish and unpublish dramas.

### Episode Management

- Create episodes.
- Upload video files.
- Integrate with Mux direct uploads.
- Add episode thumbnails.
- Configure subtitles.
- Set episode numbers.
- Set free or premium access.
- Schedule publication.
- Preview videos.
- Track processing status.

### User Management

- View registered users.
- View user information.
- Manage account status.
- Review reported content.

### Analytics

- Episode views.
- Unique viewers.
- Average watch duration.
- Completion percentage.
- Popular dramas.
- Retention metrics.

Use role-based access control.

---

## 7. Backend Architecture

Organize the backend using modular architecture.

Required modules:

1. Authentication
2. Users
3. Dramas
4. Seasons
5. Episodes
6. Categories
7. Languages
8. Watch History
9. Favorites
10. Video Streaming
11. Subscriptions
12. Payments
13. Advertisements
14. Notifications
15. Analytics
16. Admin
17. Content Reports

### Backend Rules

- Use controllers, services, repositories where justified, and validation schemas.
- Keep business logic outside route handlers.
- Use centralized error handling.
- Validate all incoming requests.
- Implement authentication middleware.
- Implement authorization and role checks.
- Use pagination for listing APIs.
- Avoid unnecessary database queries.
- Add appropriate indexes.
- Use database transactions for multi-step financial operations.
- Never expose internal database errors to users.

---

## 8. Database Design

Use PostgreSQL with Prisma.

Initial entities:

- User
- UserProfile
- Role
- Drama
- Season
- Episode
- Category
- Language
- DramaCategory
- Subtitle
- WatchHistory
- Favorite
- Subscription
- Payment
- Advertisement
- Notification
- ContentReport

Use proper foreign keys, unique constraints, indexes and timestamps.

Maintain clear relationships.

Do not store video binary files inside PostgreSQL.

Use external video hosting and store asset identifiers and metadata.

Document schema changes and create migrations.

---

## 9. UI/UX Design Guidelines

### Design Direction

Build a premium, cinematic entertainment application.

Visual inspiration:
- ReelShort
- DramaBox
- Modern OTT platforms
- Premium dark-themed mobile applications

Do not reproduce any reference application's exact UI.

### Visual Identity

Preferred direction:
- Dark cinematic background.
- Deep charcoal surfaces.
- Warm gold or amber accent.
- White primary typography.
- Muted secondary text.
- High-quality drama posters.
- Smooth transitions.
- Minimal visual clutter.

Suggested starting palette:

Primary Background: #090A0F
Secondary Background: #151720
Card Background: #1D202B
Primary Accent: #F5B544
Primary Text: #FFFFFF
Secondary Text: #A4A8B5
Error: #EF4444
Success: #22C55E

Keep colors in centralized theme tokens.

### Design Principles

- Mobile-first.
- Clean visual hierarchy.
- Consistent spacing.
- Reusable components.
- Responsive layouts.
- Proper loading states.
- Empty states.
- Error states.
- Accessible touch targets.
- Smooth animations.
- Consistent typography.

Never use placeholder-looking layouts in production screens.

Use licensed or original content imagery.

---

## 10. Coding Standards

### TypeScript

- Use strict TypeScript.
- Avoid `any`.
- Create reusable interfaces and types.
- Prefer explicit return types for important functions.
- Validate untrusted data at runtime.

### React and React Native

- Prefer functional components.
- Use hooks appropriately.
- Keep components focused.
- Avoid unnecessary re-renders.
- Extract reusable UI elements.
- Separate UI and business logic.
- Avoid giant components.
- Use stable keys for lists.

### API Integration

- Centralize API clients.
- Use environment-based configuration.
- Handle loading, success and failure states.
- Add request timeouts where appropriate.
- Handle expired authentication.
- Never expose secrets in the mobile app.

### Code Quality

- Keep files modular.
- Avoid duplicate logic.
- Use meaningful variable names.
- Remove unused code.
- Add comments for complex business logic.
- Run type checks and linting.
- Write tests for important functionality.

---

## 11. Security Guidelines

Security is mandatory.

- Never commit API keys or secrets.
- Use environment variables.
- Never trust client-side subscription status.
- Verify subscription entitlements on the backend.
- Protect administrator routes.
- Validate all uploads.
- Restrict file types and sizes.
- Use secure token storage.
- Implement rate limiting.
- Validate video playback access.
- Use signed URLs or playback tokens where required.
- Avoid exposing private user data.
- Implement account deletion.
- Follow applicable privacy and data protection requirements.

Never use hardcoded production credentials.

---

## 12. Video Streaming Requirements

Video delivery is a core part of MiniDrama.

Implement:
- Direct video upload using secure upload credentials.
- Mux asset processing.
- Playback ID management.
- HLS playback.
- Adaptive video quality.
- Thumbnail generation.
- Subtitle management.
- Video processing status.
- Playback error reporting.

Use webhooks to track video processing events.

Never expose Mux signing secrets or administrative credentials in the mobile app.

The backend must verify that the requested user has permission to access restricted episodes.

---

## 13. Performance Requirements

- Optimize image sizes.
- Use image caching.
- Use lazy loading.
- Avoid loading all episodes at once.
- Use paginated APIs.
- Optimize FlatList or FlashList usage.
- Avoid unnecessary video reinitialization.
- Handle poor network connections.
- Avoid memory leaks.
- Release video resources when no longer required.
- Optimize API response sizes.

Prioritize smooth video playback over decorative animations.

---

## 14. Testing Strategy

### Mobile Testing

- Authentication.
- Navigation.
- Video playback.
- Episode progression.
- Playback recovery.
- Watch history.
- Favorites.
- Network interruption.
- Different screen sizes.

### Backend Testing

- API validation.
- Authentication.
- Authorization.
- Database operations.
- Subscription access.
- Video access control.
- Error handling.

### Admin Testing

- Drama creation.
- Episode upload.
- Video processing.
- Publishing.
- User management.

Use Jest and appropriate React Native testing tools. Use integration tests for APIs and Maestro for critical mobile user flows.

---

## 15. Development Workflow

Work in controlled stages.

### Stage 1 – Project Foundation
- Initialize monorepo.
- Configure TypeScript.
- Configure linting and formatting.
- Create documentation.
- Establish architecture.

### Stage 2 – UI Foundation
- Design tokens.
- Reusable components.
- Navigation.
- Home screen.
- Drama details.
- Video player interface.

### Stage 3 – Backend
- Database setup.
- Authentication.
- Drama APIs.
- Episode APIs.
- Watch history.

### Stage 4 – Streaming
- Mux integration.
- Video upload.
- HLS playback.
- Playback access control.

### Stage 5 – Admin
- Admin authentication.
- Dashboard.
- Drama management.
- Episode management.

### Stage 6 – Engagement
- Favorites.
- Notifications.
- Search.
- Recommendations.

### Stage 7 – Monetization
- Subscription management.
- Rewarded advertisements.
- Payment integration.

### Stage 8 – Testing and Release
- QA.
- Performance optimization.
- Security review.
- Play Store preparation.

---

## 16. Instructions for Claude Code

You are acting as the senior software architect, senior full-stack developer, React Native engineer and code reviewer.

Follow these rules:

1. Understand requirements before implementation.
2. Inspect existing project files before modifying anything.
3. Never overwrite working code without understanding its purpose.
4. Do not generate the entire application in one step.
5. Implement one module at a time.
6. Explain major architectural decisions.
7. Ask for approval before major architectural changes.
8. Keep documentation updated.
9. Test important functionality after implementation.
10. Fix errors instead of hiding them.
11. Do not use mock data in production integrations.
12. Clearly identify mock services and temporary implementations.
13. Do not invent API responses or database fields.
14. Never claim a feature is complete without testing it.
15. Do not install unnecessary dependencies.
16. Do not copy proprietary assets, source code or content from reference applications.
17. Use original branding and reusable design components.
18. Prioritize maintainability, security and performance.

### Required Completion Report

After completing each development task, provide:

- What was implemented.
- Files created.
- Files modified.
- Dependencies added.
- Tests executed.
- Test results.
- Known issues.
- Recommended next task.

---

## 17. Current Development Priority

Do not immediately implement all application modules.

Start by:

1. Reviewing this CLAUDE.md.
2. Inspecting the repository.
3. Creating the initial documentation.
4. Finalizing the application architecture.
5. Proposing the first development milestone.
6. Waiting for approval before beginning implementation.

**Final objective:**

Build MiniDrama as a polished, reliable, scalable micro-drama streaming product with an excellent mobile viewing experience and a maintainable backend and administration system.

## 18. Free-First Development Policy

MiniDrama must follow a zero-cost-first development strategy.

### Mandatory Rules

1. Prioritize free and open-source technologies.
2. Prefer self-hosted and local development solutions.
3. Avoid paid APIs, SaaS subscriptions and commercial dependencies during MVP development.
4. Never introduce a paid service without explaining the reason and obtaining explicit approval.
5. Use free tiers only after checking their current limitations.
6. Avoid architectural lock-in to any single paid provider.
7. Keep external services behind provider interfaces wherever appropriate.

### Initial Development Choices

- Mobile: Expo React Native.
- Admin: React + Vite.
- Backend: Node.js + Express.
- Database: Local PostgreSQL.
- ORM: Prisma.
- Authentication: Local JWT + bcrypt for development.
- Video processing: FFmpeg.
- Video playback: expo-video.
- Streaming: Locally generated HLS.
- Storage: Local filesystem during development.
- API validation: Zod.
- Testing: Jest and open-source testing tools.
- Version control: Git and GitHub Free.

### Deferred Integrations

Do not integrate these until explicitly approved:

- Mux paid services.
- Cloudflare R2 paid usage.
- Paid Firebase services.
- Paid analytics platforms.
- Paid authentication providers.
- Paid video APIs.
- Paid cloud hosting.
- Paid subscription management services.

### Important

Free-first does not mean compromising security, maintainability or performance.

All temporary local services must be designed so that production integrations can be introduced later without rewriting the entire application.

Clearly distinguish:
- Free local development.
- Free hosted tiers.
- Paid production requirements.

Always report potential future operating costs before recommending a paid service.

## 19. Free-Tier-First Cloud Infrastructure Policy

MiniDrama may use free plans from commercial cloud providers.

Do not restrict the project to open-source-only infrastructure.

Preferred strategy:
- Use free tiers of reliable commercial platforms.
- Use open-source tools where they reduce costs.
- Avoid paid subscriptions during MVP development.
- Monitor storage, requests, bandwidth and compute usage.
- Never enable automatic paid upgrades without approval.
- Never assume that a service is free just because its provider offers a free CDN.

### Preferred Infrastructure

- Cloudflare R2: video assets and HLS segments within free allowance.
- Cloudflare CDN: public asset delivery and caching.
- FFmpeg: local video processing.
- PostgreSQL: local development initially.
- Vercel: admin hosting within eligible free limits.
- GitHub: source control and CI.
- Expo: mobile development and testing.

### Video Architecture

Create a provider-independent video storage abstraction.

Required operations:
- Upload original video.
- Generate HLS output using FFmpeg.
- Upload HLS playlists and segments to object storage.
- Generate thumbnails.
- Store video metadata.
- Deliver video through a CDN.
- Support protected content with appropriate authorization.

Do not assume Cloudflare R2 automatically provides video transcoding or HLS generation.

### Cost Protection

Before integrating any cloud provider:
1. Check current free-tier allowances.
2. Identify overage pricing.
3. Identify billing requirements.
4. Configure usage monitoring where available.
5. Explain possible unexpected costs.
6. Obtain approval before enabling paid usage.

Target: ₹0 infrastructure spending during MVP development.