# Mint Rewards Backend

A RESTful backend for the **Mint Rewards** platform — a recycling incentive system where users earn points by participating in waste collection events, refer others, and redeem discounts from partnered brands.

Built with **Next.js 16 API Routes**, **MongoDB/Mongoose**, and deployed on Vercel.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
  - [Users](#users)
  - [Brands](#brands)
  - [Logs](#logs)
- [Data Models](#data-models)
- [Authentication](#authentication)
- [Email Services](#email-services)

---

## Tech Stack

| Layer          | Technology                                    |
|----------------|-----------------------------------------------|
| Framework      | Next.js 16 (App Router, API Routes)           |
| Language       | TypeScript 5                                  |
| Database       | MongoDB via Mongoose 9                        |
| Auth           | JWT (jsonwebtoken) + bcryptjs                 |
| File Storage   | Vercel Blob                                   |
| Email          | Nodemailer (SMTP)                             |
| Runtime        | Node.js 18+                                   |

---

## Project Structure

```
.
├── app/
│   └── api/                    # Next.js API route handlers
│       ├── brands/             # Brand registration & lookup
│       ├── users/              # User auth, profile, campaigns, referrals
│       └── logs/               # Application event logging
├── emailServices/              # SMTP transport + HTML email templates
│   ├── emailFunction.ts
│   ├── signupConfirmation.ts
│   ├── paswordReset.ts
│   ├── referralEmail.ts
│   └── profileNotComplete.ts
├── lib/
│   ├── mongodb.ts              # Mongoose connection (cached in dev)
│   ├── models.ts               # All Mongoose schemas & models
│   ├── auth.ts                 # JWT decode & auth helpers
│   └── types.ts                # Shared TypeScript interfaces
├── scripts/
│   └── clone-legacy-brands.js  # One-off data migration utility
├── next.config.js              # CORS headers for /api/* routes
└── tsconfig.json
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- A running MongoDB instance (local or Atlas)
- SMTP credentials for email delivery
- Vercel Blob token (for brand logo uploads)

### Installation

```bash
git clone <repo-url>
cd Mint-Rewards-Backend
npm install
```

### Local Development

1. Copy the environment template and fill in your values:

```bash
cp .env.example .env.local
```

2. Start the dev server:

```bash
npm run dev
```

The API will be available at `http://localhost:3000/api`.

### Production Build

```bash
npm run build
npm start
```

---

## Environment Variables

Create a `.env.local` file at the project root with the following:

```env
# Database
MONGODB_URI=mongodb://localhost:27017/mint-rewards

# Authentication
JWT_SECRET=your-jwt-secret
NEXTAUTH_SECRET=your-nextauth-secret   # fallback if JWT_SECRET is absent
JWT_EXPIRES_IN=7d

# SMTP / Email
NEXT_SMTP_HOST=smtp.example.com
NEXT_SMTP_PORT=465
NEXT_SMTP_USERNAME=your-email@example.com
NEXT_SMTP_PASSWORD=your-smtp-password

# API URLs
NEXT_PUBLIC_API_URL=http://localhost:3000
API_URL=http://localhost:3000            # server-side fallback

# File Storage (Vercel Blob)
VERCEL_BLOB_READ_WRITE_TOKEN=your-vercel-blob-token
```

---

## API Reference

All routes are prefixed with `/api`. CORS is enabled globally for all `/api/*` routes (GET, POST, PUT, DELETE, OPTIONS).

Protected routes require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <jwt_token>
```

---

### Users

#### `POST /api/users/signup`
Register a new user account.

**Body:**
```json
{
  "email": "user@example.com",
  "password": "secret",
  "location": { "province": "...", "city": "...", "town": "..." },
  "referralCode": "ABC12345"   // optional — referrer's mintId
}
```

**Response:** `201` with user object and JWT token.

---

#### `POST /api/users/login`
Authenticate and receive a JWT token.

**Body:**
```json
{ "email": "user@example.com", "password": "secret" }
```

**Response:** `200` with JWT token and user profile.

---

#### `GET /api/users/my-profile` — Protected
Return the authenticated user's full profile.

---

#### `PUT /api/users/update-profile` — Protected
Update editable profile fields.

**Body (any subset):**
```json
{
  "userName": "...",
  "phone": "...",
  "address": "...",
  "location": { "province": "...", "city": "...", "town": "..." },
  "firstTimeLogin": false
}
```

---

#### `DELETE /api/users/delete-account` — Protected
Permanently delete the authenticated user's account.

---

#### `GET /api/users/active-campaigns` — Protected
Return all approved brands and their active campaigns.

---

#### `POST /api/users/referrals` — Protected
Send referral invitation emails to a list of addresses.

**Body:**
```json
{ "emails": ["friend@example.com", "other@example.com"] }
```

---

#### `POST /api/users/reset-password`
Request a password-reset OTP sent to the user's email.

**Body:** `{ "email": "user@example.com" }`

---

#### `POST /api/users/verify-otp`
Verify the OTP received during password reset.

**Body:** `{ "email": "user@example.com", "otp": "1234" }`

---

#### `POST /api/users/set-password`
Set a new password after a successful OTP verification.

**Body:** `{ "email": "user@example.com", "password": "newSecret" }`

---

### Brands

#### `POST /api/brands/register`
Register a new brand partner. Accepts `multipart/form-data` (logo file included).

**Fields:** `companyName`, `brandName`, `email`, `phone`, `contactName`, `category`, `description`, `registrationNumber`, `logo` (file), etc.

**Response:** `201` with the created brand object.

---

#### `GET /api/brands`
Return all brands with status `PENDING` along with their associated campaigns.

---

#### `GET /api/brands/fetch`
Return all `PENDING` brands sorted by creation date (newest first).

---

#### `GET /api/brands/[id]`
Return a single brand by its MongoDB `_id`.

---

### Logs

#### `POST /api/logs`
Create an application event log entry (fire-and-forget; does not block the caller).

**Body:**
```json
{
  "event": "page_view",
  "level": "info",
  "userId": "...",
  "route": "/home",
  "deviceId": "...",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

#### `GET /api/logs`
Query log entries. Supports URL query params: `userId`, `event`, `route`, `level`, `from` (ISO date), `to` (ISO date). Returns up to 100 entries.

---

## Data Models

### User
| Field              | Type     | Notes                                      |
|--------------------|----------|--------------------------------------------|
| `email`            | String   | Unique                                     |
| `password`         | String   | Bcrypt hashed                              |
| `mintId`           | String   | Unique 8-digit ID                          |
| `role`             | Enum     | `MEMBER`, `ADMIN`, `CAPTAIN`, `BRAND`, etc.|
| `points`           | Number   | Starts at 100; +150 per successful referral|
| `referrals`        | [String] | Referred email addresses                   |
| `firstTimeLogin`   | Boolean  | UI onboarding flag                         |
| `emailVerified`    | Boolean  |                                            |
| `otpVerification`  | String   | Stored during password reset flow          |

### Brand
| Field                | Type   | Notes                                |
|----------------------|--------|--------------------------------------|
| `companyName`        | String |                                      |
| `email`              | String | Unique                               |
| `registrationNumber` | String | Unique                               |
| `logo`               | String | Vercel Blob URL                      |
| `status`             | Enum   | `PENDING`, `APPROVED`, `REJECTED`    |
| `themeColor`         | String | Default `#3B82F6`                    |

### Campaign
| Field               | Type     | Notes                             |
|---------------------|----------|-----------------------------------|
| `name`              | String   |                                   |
| `brand`             | ObjectId | Ref → Brand                       |
| `discountCodes`     | [String] | Required, non-empty               |
| `isSingleCode`      | Boolean  | One code shared vs. per-user      |
| `discountPercentage`| Number   |                                   |
| `status`            | Enum     | `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED` |
| `startDate/endDate` | Date     |                                   |

### Captain
Waste collection agents. Fields: `email`, `password` (hashed), `name`, `phone`, `nationalId`, `nationalIdImage`, `avatar`. Role is always `CAPTAIN`.

### Collection
Represents a waste collection event. Tracks `area`, `city`, `radius`, participating `users`, assigned `captainsWithDates`, and `status` (`PENDING` / `COMPLETED`).

### Log
Application event entries. Auto-deleted after **90 days** (TTL index on `timestamp`). Fields include `event`, `level`, `userId`, `route`, `deviceId`, `platform`, `appVersion`, and an `extra` catch-all JSON field.

---

## Authentication

- Tokens are signed JWTs (HS256), valid for `JWT_EXPIRES_IN` (default `7d`).
- Auth helpers in `lib/auth.ts`:
  - `checkAuth(request)` — decodes the Bearer token; returns `null` on failure.
  - `getAuthenticatedUserId(request)` — extracts `id` or `sub` from the token payload.
- There is no refresh-token mechanism; clients must re-authenticate on expiry.

### User Roles

| Role                 | Description              |
|----------------------|--------------------------|
| `ADMIN`              | System administrator     |
| `MEMBER`             | Regular end user         |
| `CAPTAIN`            | Waste collection captain |
| `LOGISTIC`           | Logistics partner        |
| `BRAND`              | Brand/business partner   |
| `BUSINESS_DEVELOPMENT` | BD team member         |
| `BD_ADMIN`           | BD administrator         |

---

## Email Services

Email is sent via Nodemailer over SMTP (configured through `NEXT_SMTP_*` env vars). Templates live in `emailServices/` and are plain HTML strings.

| Template                    | Trigger                              |
|-----------------------------|--------------------------------------|
| `signupConfirmation`        | New user registration                |
| `paswordReset`              | Password reset OTP                   |
| `referralEmail`             | Referral invitations                 |
| `profileNotComplete`        | Profile completion reminder          |
