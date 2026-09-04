# Mint Rewards Backend

The API for the **Mint Rewards** platform — a recycling incentive system where
consumers earn points, and partner brands run campaigns and issue redeemable
deals.

Built with **Next.js 16 App Router route handlers**, **MongoDB/Mongoose 9**, and
deployed on Vercel. There is no UI in this repo.

> **Taking this over?** Start with **[`docs/HANDOFF.md`](docs/HANDOFF.md)** — the
> master handoff. This README is the day-to-day reference.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Authentication](#authentication)
- [API Reference](#api-reference)
- [Data Models](#data-models)
- [Email](#email)
- [Testing & CI](#testing--ci)
- [Scripts](#scripts)
- [Documentation Map](#documentation-map)

---

## Tech Stack

| Layer        | Technology                                                |
| ------------ | --------------------------------------------------------- |
| Framework    | Next.js 16 (App Router route handlers)                    |
| Language     | TypeScript 5.9                                            |
| Database     | MongoDB Atlas via Mongoose 9                              |
| Auth         | JWT (`jsonwebtoken`) + `bcryptjs` — four separate systems |
| File storage | Vercel Blob                                               |
| Email        | Resend (+ Svix-verified webhooks)                         |
| Social login | `google-auth-library`, Apple Sign In                      |
| Runtime      | Node.js 24 (CI pins `24`; Vercel serves the Next build)   |
| Hosting      | Vercel — project `mint-rewards-backend`                   |

`express`, `helmet` and `express-rate-limit` appear in `package.json` but **this
is not an Express backend** — they back the `supertest` harness in `app.ts` only.
`pg` is present for the Postgres migration rehearsal scripts; the running app is
100% Mongoose. See [`docs/HANDOFF.md`](docs/HANDOFF.md) §7 and §8.

---

## Project Structure

```
.
├── app/api/                     # Next.js route handlers — the actual API
│   ├── admin/login/             # Global admin token issuance
│   ├── app-config/              # Public mobile force-update + gate config
│   ├── auth/{google,apple}/     # Social login
│   ├── brandhub/                # Module-gated multi-tenant brand portal API
│   ├── brands/                  # Brand registration, admin moderation, brand self-service
│   ├── coupons/[couponId]/      # Campaign coupon redemption (deprecated for mobile)
│   ├── email/unsubscribe/       # Signed, session-less unsubscribe
│   ├── health/                  # Liveness — hit by CI smoke test and ZAP
│   ├── location/                # Reverse geocoding (LocationIQ)
│   ├── logs/                    # Application event log (admin-read)
│   ├── users/                   # Consumer auth, profile, location, deals, referrals
│   └── webhooks/resend/         # Bounce/complaint ingestion
├── emailServices/               # Resend transport + HTML templates
├── lib/                         # Models, auth guards, domain helpers, env
│   ├── env.ts                   # SINGLE SOURCE OF ENV TRUTH — read this first
│   ├── models.ts                # Every Mongoose schema (one file, deliberately)
│   ├── types.ts                 # Shared interfaces
│   └── data/locationRegistry.json  # Generated — synced from the app repo
├── scripts/                     # Seeds, migration/ETL rehearsal, API baseline
├── __tests__/                   # Jest suites (33 files)
├── docs/                        # Handoff, vocabulary, migration plan
├── app.ts                       # Express adapter — TEST HARNESS ONLY
├── middleware.ts                # CORS allowlist over /api/:path*
└── next.config.js
```

---

## Getting Started

### Prerequisites

- Node.js 24
- MongoDB Atlas access (or a local **replica set** — BrandHub registration uses a
  transaction, which standalone `mongod` does not support)
- A Resend API key
- A Vercel Blob read/write token

### Install and run

```bash
git clone https://github.com/Mint-Rewards/Mint-Rewards-Backend.git
cd Mint-Rewards-Backend
npm install
cp .env.example .env          # then fill it in
npm run dev                   # http://localhost:3000/api
```

`lib/env.ts` validates the whole environment at module load and throws **one**
error naming **every** missing or malformed key — so if it boots, the config is
sound.

To develop against the isolated test database instead:

```bash
npm run seed:personas         # five QA orgs, password "test1234"
npm run dev:testdb            # next dev with MONGODB_URI := MONGODB_URI_TEST
```

### Production build

```bash
npm run build
npm start
```

---

## Environment Variables

`.env.example` is the annotated, authoritative list — it is kept in sync with
`lib/env.ts` by `__tests__/envExample.test.ts`. Summary:

**Required (deployment will not boot without these)**

| Variable                                                          | Notes                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `APP_ENV`                                                         | Exactly `development` or `production`                              |
| `MONGODB_URI`                                                     | In development, `MONGODB_URI_TEST` takes precedence when set       |
| `JWT_SECRET`                                                      | Consumer sessions. Min 16 chars                                    |
| `BRANDHUB_JWT_SECRET`                                             | BrandHub sessions — deliberately a different secret                |
| `ADMIN_JWT_SECRET`                                                | Global admin                                                       |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`                              | bcrypt hash; write `$` as `\$` in `.env` (see `lib/env.ts`)        |
| `OTP_PEPPER`                                                      | HMAC pepper for stored OTP hashes                                  |
| `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_WEB_CLIENT_ID`, `APPLE_BUNDLE_ID` | Social login audiences                                             |
| `RESEND_API_KEY`, `EMAIL_FROM`                                    | Outbound mail                                                      |
| `DEV_MAIL_REDIRECT_TO`                                            | **Required** when `APP_ENV != production`, **rejected** when it is |
| `BLOB_PUBLIC_READ_WRITE_TOKEN`                                    | Vercel Blob                                                        |
| `ALLOWED_ORIGINS`                                                 | Comma-separated exact origins for CORS                             |

**Optional**

`JWT_EXPIRES_IN` (default `7d`; production runs `30d`) · `MONGODB_URI_TEST` ·
`POSTGRES_URL_TEST` · `RESEND_WEBHOOK_SECRET` (route fails closed while unset) ·
`EMAIL_POSTAL_ADDRESS` · `APP_DOWNLOAD_URL` · `PUBLIC_BASE_URL` ·
`LOCATIONIQ_API_KEY` (unset ⇒ reverse-geocode returns `{ resolved: false }`) ·
`MIN_SUPPORTED_APP_VERSION` · `MIN_SUPPORTED_BUILD_{IOS,ANDROID}` ·
`{IOS,ANDROID}_STORE_URL` · `FORCE_OTA_UPDATE` · `LOCATION_GATE_*` ·
`PROFILE_BONUS_*`.

Every optional gate defaults to **"gates nothing"**. `LOCATION_GATE_MODE` must
stay `soft` in the deployed environment until app 2.1.11 adoption justifies
`hard`.

### CORS

`middleware.ts` applies an exact-origin allowlist over `/api/:path*`. Outside
production, with an empty allowlist, `http://localhost:*` is permitted. Requests
with no `Origin` header (mobile, curl, server-to-server) pass through untouched —
CORS is browser-only enforcement.

---

## Authentication

Four independent systems, four secrets. A token from one is never valid in
another. Full detail in [`docs/HANDOFF.md`](docs/HANDOFF.md) §2.

| System         | Guard                                                            | Header                    |
| -------------- | ---------------------------------------------------------------- | ------------------------- |
| Consumer user  | `getAuthenticatedUserId` / `checkAuth`                           | `Authorization: Bearer …` |
| BrandHub user  | `requireBrandAuth` → `requireModuleAccess` → `requireBrandScope` | `Authorization: Bearer …` |
| Global admin   | `requireAdminAuth` (`role: "admin"` claim)                       | `Authorization: Bearer …` |
| Resend webhook | `verifySvix`                                                     | `svix-*` headers          |

- Consumer tokens carry `{ id }` — a Mongo ObjectId. There is no refresh token;
  clients re-authenticate on expiry.
- Tokens carrying a `purpose` claim (password reset) are single-use and are
  rejected for general requests.
- `requireBrandScope` answers **404, not 403**, for a brand outside your org.
- BrandHub org roles: `owner`, `admin`, `member`. Module permissions are
  hierarchical: `manage` > `write` > `read`.
- Modules: `consumer-reporting`, `esg`, `minttrace` (`lib/modules.ts`).

Consumer `User.role` is a separate, flat, global enum: `ADMIN`, `MEMBER`,
`LOGISTIC`, `BUSINESS_DEVELOPMENT`, `BD_ADMIN`, `CAPTAIN`, `BRAND`.

---

## API Reference

All routes are under `/api`. **Auth** column: `—` public, `user` consumer JWT,
`brand` BrandUser session, `module` BrandUser + module permission, `admin`
global admin, `svix` webhook signature.

### Consumer — auth and profile

| Route                            | Methods   | Auth | Notes                                               |
| -------------------------------- | --------- | ---- | --------------------------------------------------- |
| `/users/signup`                  | GET, POST | —    | Rate-limited. `409` on a known email                |
| `/users/login`                   | GET, POST | —    | Rate-limited                                        |
| `/auth/google`, `/auth/apple`    | POST      | —    | Social login/signup                                 |
| `/users/reset-password`          | POST      | —    | Sends an OTP. Rate-limited **before** the lookup    |
| `/users/verify-otp`              | POST      | —    | Verifies the reset OTP                              |
| `/users/set-password`            | POST      | —    | New password after OTP verification                 |
| `/users/verify-email-otp`        | POST      | —    | Email verification                                  |
| `/users/resend-verification-otp` | POST      | —    | Rate-limited                                        |
| `/users/my-profile`              | GET       | user |                                                     |
| `/users/update-profile`          | PUT       | user | Allowlisted fields only; may trigger a points grant |
| `/users/location`                | PATCH     | user | Progressive save; dual-writes legacy fields         |
| `/users/delete-account`          | DELETE    | user |                                                     |

### Consumer — incentives

| Route                          | Methods         | Auth | Notes                                                        |
| ------------------------------ | --------------- | ---- | ------------------------------------------------------------ |
| `/users/deals`                 | GET             | user | Active deals from approved brands. **Never returns `codes`** |
| `/users/deals/[dealId]/redeem` | POST            | user | Atomically claims exactly one code. Idempotent per user      |
| `/users/brands`                | GET             | user |                                                              |
| `/users/referrals`             | POST            | user | Sends invitations. Rate-limited, suppression-aware           |
| `/users/active-campaigns`      | GET             | user | Campaign-backed; correctly named                             |
| `/users/my-discounts`          | GET, PATCH, PUT | user | **Deprecated for mobile** — reads _campaigns_                |
| `/coupons/[couponId]/redeem`   | PATCH           | user | **Deprecated for mobile** — `couponId` is a campaign `_id`   |

The two deprecated routes are documented carryovers, not bugs — see
[`docs/VOCABULARY.md`](docs/VOCABULARY.md). New consumer-incentive work goes on
`Deal`.

### Brands — registration, moderation, self-service

| Route                                 | Methods       | Auth  | Notes                                               |
| ------------------------------------- | ------------- | ----- | --------------------------------------------------- |
| `/brands/register`                    | POST          | —     | Public sign-up form. `multipart/form-data` + logo   |
| `/brands`                             | GET           | admin | Every brand regardless of status — moderation view  |
| `/brands/fetch`                       | GET           | admin | Approved brands + approved campaigns + active deals |
| `/brands/campaigns`, `/brands/deals`  | GET           | admin | Cross-brand review queues                           |
| `/brands/[id]`                        | GET, PATCH    | admin | PATCH approves/rejects                              |
| `/brands/[id]/settings`               | PATCH         | brand |                                                     |
| `/brands/[id]/analytics`              | GET           | brand |                                                     |
| `/brands/[id]/deals`                  | GET, POST     | brand | POST also `admin`                                   |
| `/brands/[id]/deals/[dealId]`         | PATCH, DELETE | brand | also `admin`                                        |
| `/brands/[id]/campaigns`              | GET, POST     | brand |                                                     |
| `/brands/[id]/campaigns/[campaignId]` | PATCH, DELETE | brand | also `admin`                                        |

### BrandHub — multi-tenant portal

| Route                                               | Methods       | Auth   |
| --------------------------------------------------- | ------------- | ------ |
| `/brandhub/auth/register`                           | POST          | —      |
| `/brandhub/auth/login`                              | POST          | —      |
| `/brandhub/brands`                                  | GET, POST     | brand  |
| `/brandhub/brands/[brandId]`                        | GET, PATCH    | brand  |
| `/brandhub/brands/[brandId]/analytics`              | GET           | module |
| `/brandhub/brands/[brandId]/deals`                  | GET, POST     | module |
| `/brandhub/brands/[brandId]/deals/[dealId]`         | PATCH, DELETE | module |
| `/brandhub/brands/[brandId]/campaigns`              | GET, POST     | module |
| `/brandhub/brands/[brandId]/campaigns/[campaignId]` | PATCH, DELETE | module |
| `/brandhub/modules/[module]`                        | GET, POST     | module |

`/brands/[id]/*` and `/brandhub/brands/[brandId]/*` overlap; the difference is
module gating. Consolidating them is an open decision — see
[`docs/HANDOFF.md`](docs/HANDOFF.md) §2.

### Platform

| Route                       | Methods   | Auth  | Notes                                                                   |
| --------------------------- | --------- | ----- | ----------------------------------------------------------------------- |
| `/health`                   | GET       | —     | `force-dynamic`. CI smoke test target                                   |
| `/app-config`               | GET       | —     | Force-update + location gate + profile bonus. `force-dynamic`           |
| `/location/reverse-geocode` | POST      | user  | Rate-limited, permanently cached. `{resolved:false}` without an API key |
| `/admin/login`              | POST      | —     | Issues the admin token                                                  |
| `/logs`                     | POST, GET | admin | 90-day TTL on entries                                                   |
| `/email/unsubscribe`        | GET, POST | —     | Signed token — the recipient has no account                             |
| `/webhooks/resend`          | POST      | svix  | Fails closed while `RESEND_WEBHOOK_SECRET` is unset                     |

Exact request/response contracts are exercised by `scripts/test-api.mjs`
(27 checks) and captured in `baseline-mongoose.json`.

---

## Data Models

All Mongoose schemas live in `lib/models.ts`; interfaces in `lib/types.ts`.
Infrastructure-only models that serve exactly one route (`lib/rateLimit.ts`,
`lib/geocodeCache.ts`, `lib/emailSuppression.ts`) are the deliberate exception.

### User (`users`)

Consumer account. `email` and `mintId` unique, `appleId` sparse-unique.
`password` bcrypt-hashed. `points` defaults to **0**.

Notable groups:

- **Legacy location** — `address`, `province`, `city`, `town`, `townOther`,
  `subArea`, `subAreaOther`, `latitude`/`longitude` (**strings**). Still
  dual-written.
- **Structured location (P0.3)** — GeoJSON `location` (`[lng, lat]`, note the
  order), `source`, `precision`, `structuredAddress`, `locationVersion`,
  `locationCompletedAt`. Anything less precise than `building` must be excluded
  from routing.
- **Referrals** — `referrals[]` (multikey-indexed; unbounded by design, see the
  comment) and `referralRewardGranted`.
- **Profile bonus** — `profileBonusWindowStartedAt`, `profileBonusGrantedAt`,
  `profileBonusPoints`. All **server-stamped**, deliberately undefaulted, and
  must never be added to `update-profile`'s allowlists.
- **OTP** — `passwordReset` and `emailVerification` sub-documents are
  `select: false` so the hashes never leak through `toObject()`/`find()`.
- `pickupHistory[]` — schema exists; **nothing writes it**.

### Brand (`brands`)

`email` and `registrationNumber` unique. `status`: `PENDING` | `APPROVED` |
`REJECTED`. `logo` is a Vercel Blob URL. `orgId` links it to an Organization —
brands without one are legacy and unreachable via BrandHub auth.
`legacyBrandId` (indexed) pairs a BrandHub clone with its legacy original.
`environmentalStats` plus dated `environmentalPeriods` buckets (kept as separate
fields so legacy documents still read).

### Deal (`deals`)

The consumer incentive. `brand` ref, `title`, `discountPercentage` /
`discountAmount`, `codes[]` (the inventory), `promoCode` (mirrors `codes[0]` for
legacy readers), `startDate`/`endDate` (**strings**), `maxUses`, `currentUses`,
`status`: `pending` | `active` | `rejected` | `inactive` | `expired`, plus
`users[]` and `claims[]` (`{user, code, claimedAt}`).

### Campaign (`campaigns`)

Despite the name, structurally a Discount-type Deal: `discountCodes[]`,
`isSingleCode`, `discountPercentage`, redeeming `users[]`, and **no**
recycling-programme fields. `status`: `PENDING` | `APPROVED` | `REJECTED` |
`EXPIRED`. Do not add incentive fields here — see
[`docs/VOCABULARY.md`](docs/VOCABULARY.md).

### Organization (`organizations`) and BrandUser (`brandusers`)

The BrandHub tenancy pair. `Organization` has `plan`
(`starter`|`growth`|`enterprise`) and `moduleSubscriptions[]`
(`module`, `status`, `activatedAt`, `expiresAt`). `BrandUser` has `orgId`,
unique `email`, `passwordHash`, `orgRole` (`owner`|`admin`|`member`) and
`moduleAccess[]`.

### Others

`Captain`, `Logistics` (own `password` + `role`, structurally like `User`),
`Collection` (waste collection events — `area`, `city`, `radius`, `users`,
`captainsWithDates`, `status`), `Location`, `BrandTheme`, and `Log`
(90-day TTL on `timestamp`, with an `extra` catch-all).

`DiscountModel` was **deleted**, not renamed — see `docs/VOCABULARY.md`.

### Database connection

`lib/mongodb.ts` exports `connectToDatabase` (default), plus `withDatabase()`
and `connectToBothDatabases()`. The connection is cached at module level so
serverless invocations and hot reloads reuse it.

**`lib/models.ts` never opens the connection at import time.** The driver runs
with `bufferCommands: false`, so every caller must `await connectToDatabase()`
before querying — routes do this at the top of each handler.

---

## Email

Sent via **Resend**. Templates are plain HTML strings in `emailServices/`.

| Template             | Trigger                     |
| -------------------- | --------------------------- |
| `signupConfirmation` | New user registration       |
| `paswordReset`       | Password reset OTP          |
| `referralEmail`      | Referral invitations        |
| `profileNotComplete` | Profile completion reminder |

- Outside production, **every** message is redirected to `DEV_MAIL_REDIRECT_TO`.
- `lib/emailSuppression.ts` holds the do-not-email list (the address is the
  `_id`). Outreach mail must supply an unsubscribe URL, which becomes the
  `List-Unsubscribe` header.
- `lib/unsubscribeToken.ts` signs session-less unsubscribe links.
- `POST /api/webhooks/resend` ingests bounces and complaints, Svix-verified.

---

## Testing & CI

```bash
npm test              # 345 tests, 33 suites
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier
```

Tests run against a **real Atlas database** named by `MONGODB_URI_TEST`.
`jest.setup.js` requires that variable by name and remaps it onto `MONGODB_URI`
— passing the URI as `MONGODB_URI` trips a refuse-to-run guard. Seed and
migration scripts carry the same guard.

CI (`.github/workflows/backend-ci.yml`) runs npm audit → lint → format → typecheck
→ tests → build, then smoke-tests `/api/health` against production on a `main`
push. Every run is serialised behind one `concurrency` group because they all
share a single test database. `codeql.yml` (SAST, weekly) and `dast.yml` (ZAP)
also run.

> `app.ts` mounts two route handlers on Express for `supertest` **only**. Vercel
> serves the Next build, where only `<dir>/route.ts` is a route — an Express-only
> endpoint passes its jest test and 404s in production. This has happened.

---

## Scripts

| Command / script                       | Purpose                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run seed:personas`                | Five QA orgs for BrandHub acceptance testing. Idempotent. Password `test1234` |
| `npm run dev:testdb`                   | `next dev` against `MONGODB_URI_TEST`                                         |
| `scripts/seed-brandhub-demo.js`        | Demo world; refuses to run outside a db named `test_db`                       |
| `scripts/seed-brandhub-rbac.js`        | RBAC fixtures                                                                 |
| `scripts/clone-legacy-brands.js`       | Clones legacy brands into BrandHub documents                                  |
| `scripts/location-backfill-audit.js`   | Read-only location backfill audit                                             |
| `scripts/test-api.mjs --local`         | 27 end-to-end API checks. `--record <f>` captures a baseline                  |
| `scripts/api-baseline.mjs compare a b` | Diffs two baselines (exits non-zero). `rules` prints the rules                |

Postgres migration tooling (`migrate-mongo-to-postgres-normalized.mjs`,
`audit-mongo-shape.mjs`, `seed-etl-*.mjs`, `verify-etl-fixtures.mjs`) is
inventoried in
[`docs/plans/HANDOFF-2026-09-02-postgres-migration.md`](docs/plans/HANDOFF-2026-09-02-postgres-migration.md).
Everything there is hard-locked to URIs containing `test` and requires `--yes`.

---

## Documentation Map

| Doc                                                           | Read it for                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `docs/HANDOFF.md`                                             | **Master handoff.** Everything a new owner needs            |
| `docs/VOCABULARY.md`                                          | Canonical domain terms. Read before naming anything         |
| `docs/postgres-migration-plan.md`                             | Migration design and decision record                        |
| `docs/postgres-schema-proposal.dbml`                          | Target schema — source of truth                             |
| `docs/plans/HANDOFF-2026-09-02-postgres-migration.md`         | Migration status, tooling, traps                            |
| `docs/plans/HANDOFF-2026-08-25.md`                            | Location capture — historical, mostly delivered             |
| `docs/plans/p1-backend-services.md`, `p3-1-backfill-audit.md` | Location-capture executable plans                           |
| `AUDIT.md`                                                    | 2026-07-01 security audit — **superseded**, kept for record |
| `CLAUDE.md`                                                   | Agent conventions (graphify, vocabulary)                    |
