# Backend handoff — everything you need to take this over

**Written 2026-09-04.** Repo: `Mint-Rewards/Mint-Rewards-Backend` (public).
Current branch at time of writing: `feature/postgres-migration-rehearsal`
(`e45e51b`, pushed). `main` is `c59832a`, pushed.

Read this first, then the three companion docs, in this order:

| Doc                                                   | What it is                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `README.md`                                           | Stack, setup, full route table, data models. The day-to-day reference.          |
| `docs/VOCABULARY.md`                                  | Canonical domain terms across all three repos. **Read before naming anything.** |
| `docs/plans/HANDOFF-2026-09-02-postgres-migration.md` | The Postgres migration in full. The largest in-flight project.                  |
| `AUDIT.md`                                            | Historical security audit (2026-07-01). Superseded — kept for the record.       |

---

## 1. What this service is

A Next.js 16 App Router API (no UI) serving **three** distinct clients:

1. **Mint Rewards mobile app** (`Mint-Rewards-App`, Expo/React Native) —
   consumers who earn points for recycling and redeem brand deals.
2. **BrandHub** (`Mint-Rewards-BrandHub`, Vite SPA) — brand partners who run
   campaigns and issue deals.
3. **Internal admin** — a single global admin identity, no UI in this repo.

Deployed on Vercel as project `mint-rewards-backend`
(`https://mint-rewards-backend.vercel.app`). Data lives in MongoDB Atlas via
Mongoose 9. **The live app is 100% Mongoose** — the Postgres work is rehearsal
tooling only, nothing in `app/` talks to Postgres.

### The three-repo relationship

This backend is the only server. BrandHub and the app are both pure clients.
Two cross-repo rules are load-bearing and nothing automated enforces either:

- **Location registry sync.** Any change to the app repo's
  `utils/pakistan_areas.ts` requires regenerating **both** artifacts: the app's
  `utils/__generated__/locationRegistry.json` and this repo's
  `lib/data/locationRegistry.json`. A stale backend copy is caught by nothing
  but discipline. (`__tests__/locationRegistryVersionGuard.test.ts` catches a
  version mismatch, not a content drift against the app repo.)
- **Vocabulary.** `docs/VOCABULARY.md` is canonical for all three repos.

---

## 2. Four auth systems, deliberately separate

This is the single most important thing to internalise. There are four
independent identity systems with **four different secrets**, and a token from
one is never valid in another.

| System         | Guard                                                  | Secret                  | Lifetime                                             | Payload                                                                     |
| -------------- | ------------------------------------------------------ | ----------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Consumer user  | `getAuthenticatedUserId` / `checkAuth` (`lib/auth.ts`) | `JWT_SECRET`            | `JWT_EXPIRES_IN` (7d default; **production is 30d**) | `{ id }` — a Mongo ObjectId                                                 |
| BrandHub user  | `requireBrandAuth` (`lib/requireBrandAuth.ts`)         | `BRANDHUB_JWT_SECRET`   | 8h (hardcoded)                                       | `{ userId, orgId, orgRole, moduleAccess }`                                  |
| Global admin   | `requireAdminAuth` (`lib/requireAdminAuth.ts`)         | `ADMIN_JWT_SECRET`      | —                                                    | `{ role: "admin" }`, credentials from `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH` |
| Resend webhook | `verifySvix` (`lib/svix.ts`)                           | `RESEND_WEBHOOK_SECRET` | 5-min tolerance                                      | HMAC over `id.timestamp.body`                                               |

`lib/auth.ts` also refuses any token carrying a `purpose` claim — those are
single-use flow tokens (password reset) and must never authenticate a general
request.

### BrandHub authorization is a three-layer chain

BrandHub is multi-tenant. A request is authorized by composing three helpers,
in this order:

```
requireBrandAuth(req)          → valid BrandUser session (401 otherwise)
requireModuleAccess(req, m, p) → org subscribes to module m (402)
                                 AND user has permission p on it (403)
requireBrandScope(payload, id) → the brand exists AND belongs to caller's org
```

Notes that matter:

- `requireBrandScope` returns **404, not 403**, for a brand outside your org —
  deliberately, so it does not confirm the brand exists to an outside caller.
- Legacy brands with no `orgId` are unreachable via BrandHub auth. They must be
  adopted into an org first.
- Modules are `consumer-reporting`, `esg`, `minttrace` — defined in
  `lib/modules.ts` (`MODULE_CATALOGUE`). Adding one is a one-line edit; module
  ids are validated at the application layer, not in a schema enum.
- Permissions are hierarchical: `manage` > `write` > `read`.
- Since commit `51da092`, **all modules are active for new orgs**, which makes
  the `402 no subscription` branch unreachable over HTTP for a freshly
  registered org. Reaching it requires removing a subscription in the DB.

### Two parallel brand API surfaces — an open question

`/api/brands/[id]/*` and `/api/brandhub/brands/[brandId]/*` both serve brand
self-service and largely overlap. The difference:

- `/api/brands/[id]/*` uses `requireBrandAuth` + `requireBrandScope` — session
  and tenancy, **no module gating**.
- `/api/brandhub/brands/[brandId]/*` adds `requireModuleAccess`.

Both are live and BrandHub calls both. Nobody has ruled on consolidating them.
**Do not add a third.** If you touch one, check the other.

---

## 3. Recently closed: the security posture

`AUDIT.md` (2026-07-01) found seven unauthenticated endpoints and a JWT
fallback that accepted unverified tokens. **All of them are closed.** Verified
2026-09-04 by grepping every `route.ts` for guards:

- Every brand-scoped route now runs `requireBrandAuth` + `requireBrandScope`.
- `lib/auth.ts` no longer falls back to `jwt.decode` — a missing secret returns
  `null` (fails closed). `lib/env.ts` makes the secret required at boot anyway.
- `/api/users/delete-account` is guarded.
- `/api/brands/fetch` is now `requireAdminAuth`.

What is deliberately public, and why: `/api/health`, `/api/app-config` (the
mobile force-update kill switch — the client calls it before login),
`/api/auth/google`, `/api/auth/apple`, `/api/users/{signup,login,reset-password,
set-password,verify-otp,verify-email-otp,resend-verification-otp}`,
`/api/brands/register` (the public brand sign-up form),
`/api/brandhub/auth/{register,login}`, `/api/email/unsubscribe` (the recipient
has no account — that is the point; the link is signed instead).

### Two GitHub security advisories, filed as drafts

The repo is public, so these were filed as **draft** advisories (visible to
repo admins only). Convert to public advisories once fixed.

- **GHSA-hrfp-f4qf-8c39** · MEDIUM · user enumeration via
  `POST /api/users/reset-password`. **Status changed since it was filed**: the
  route now documents the 404 as a deliberate product decision ("no longer an
  anti-enumeration hedge — unknown emails now get a 404"), with rate limits
  ahead of the existence check as the mitigation. Note `scripts/test-api.mjs`
  still asserts the old generic-200 contract. **Owner decision needed:** close
  the advisory as accepted-with-mitigation and fix the test, or restore the
  generic response.
- **GHSA-7xqq-85f9-9r5m** · LOW · account/brand enumeration via the three
  registration endpoints returning 409 on a known identity. Filed as a decision,
  not a defect — a registration endpoint cannot silently accept a duplicate.
  Cheapest mitigation is rate limiting; `lib/rateLimit.ts` already exists and is
  already wired onto these routes.

### Rate limiting

`lib/rateLimit.ts` — a Mongo-backed counter with a TTL index, keyed by IP or by
a **hashed** email (raw identifiers are never stored). Applied to signup, login,
password reset, OTP flows and reverse-geocode. On `reset-password` the ordering
is load-bearing: both rate-limit checks must stay **ahead** of the `findOne`,
or enumeration becomes free.

The `express-rate-limit` in `app.ts` is test-harness only (see §7).

---

## 4. Environment — one file governs everything

**`lib/env.ts` is the single source of environment truth.** It parses and
validates every variable once, at module load, and throws **one** error naming
**every** missing or malformed key. A misconfigured deployment fails at boot,
not as a 500 on whichever route is hit first.

Read the file. Its comments explain each defaulting decision, and several of
them are safety-critical:

- `MIN_SUPPORTED_APP_VERSION` defaults to `"0.0.0"` — an unset or typo'd value
  must mean "block nobody", because a blocked app is the thing that would have
  to fetch the fix.
- `LOCATION_GATE_MODE` **must stay `soft`** in the deployed environment until
  app 2.1.11 store adoption justifies `hard`.
- `DEV_MAIL_REDIRECT_TO` is **required** when `APP_ENV != production` and
  **rejected** when it is. Non-prod cannot boot without a mail sink; every
  outbound message is rewritten to it. This is what stops a dev deployment
  emailing real users.
- `PROFILE_BONUS_ENABLED` defaults false — the feature ships dark and is turned
  on by setting dates, not by deploying.
- `ADMIN_PASSWORD_HASH` needs `\$` escaping in `.env` because Next's loader
  does shell-style `$VAR` expansion and `dotenv` (jest, scripts) does not.
  `unescapeDollars` in `lib/env.ts` makes both loaders converge.
- `middleware.ts` must **never** import `lib/env.ts` — a throw at module load in
  the middleware bundle takes down the whole `/api/:path*` matcher. Middleware
  uses `lib/envShared.ts`, which fails closed instead.

`.env.example` is the full annotated list, and `__tests__/envExample.test.ts`
keeps it honest against `lib/env.ts`.

CORS lives in `middleware.ts`: an exact-origin allowlist from `ALLOWED_ORIGINS`,
with a localhost fallback only outside production and only when the allowlist is
empty. Requests with no `Origin` header (mobile, curl, server-to-server) pass
through untouched — CORS is browser-only enforcement.

---

## 5. The mobile force-update / gate mechanism

`GET /api/app-config` is the kill switch for every installed app. It is
`force-dynamic` — a prerendered constant would mean raising the minimum version
has no effect until the next deploy.

Two gates ride on it, and the split of responsibility is deliberate:

- **Force-update gate** — `minSupportedVersion`, `minSupportedBuildNumber`,
  store URLs, `forceOTA`. Build numbers are assigned remotely by EAS
  (`appVersionSource: "remote"`), which makes the build number the finer-grained
  and more reliable gate of the two.
- **Location gate** — the server only _serves_ `locationGate`; the resolution
  order (build-forced escalation, dismissal counts) is **client** logic. Tuning
  it is a client release, not a server deploy.
- **Profile bonus** — the server serves display copy, and independently re-reads
  the same values at payout time in `lib/profileBonus.ts`. A client holding a
  stale or forged config can misrender a badge but cannot cause a payment.

---

## 6. Domain flows worth knowing before you change anything

### Points

Two guarded grants, both structured identically and both **never throwing** — a
payout failure must not fail the request that triggered it:

- `lib/referrals.ts` — `REFERRAL_REWARD_POINTS = 50`, idempotency on the _new_
  user's `referralRewardGranted` flag.
- `lib/profileBonus.ts` — idempotency on `profileBonusGrantedAt`.

Both use **a flag plus a filtered atomic `findOneAndUpdate`**, never a read
followed by a write. Copy that shape for any future grant.

Note `update-profile` pays referrals on a looser predicate (`phone && address`)
than `lib/evaluateProfileCompletion.ts` uses for the bonus. That divergence is
deliberate and documented in the latter file — do not "unify" them without
thinking about who gets paid.

### Deals vs campaigns — the redemption difference

Read `docs/VOCABULARY.md` first. Then the mechanical difference:

- **Campaign coupons** (`/api/coupons/[couponId]/redeem`, `/api/users/my-discounts`)
  may hand the _same_ code to every user. Deprecated for the mobile client.
- **Deal codes** (`/api/users/deals/[dealId]/redeem`) are an **inventory** —
  each code goes to exactly one user, so the claim is a single guarded
  `findOneAndUpdate` that both selects the code by position (`currentUses`) and
  commits the claim. Two concurrent requests cannot receive the same code.
- `GET /api/users/deals` **never returns the `codes` array.** Handing the
  inventory to a client would let one user take every code.

`lib/dealCodes.ts` owns code validation and generation for both surfaces:
max 500 per request, `[A-Z0-9-_]{4,32}`, generated over an alphabet with no
`0/O/1/I/L`.

### Legacy brands

Brands exist twice: an original legacy document and a BrandHub clone made by
`scripts/clone-legacy-brands.js`. The pairing lives in `Brand.legacyBrandId`
(indexed). It **used to** be encoded in the clone's email as
`legacy-<24hex>@example.com`, which broke every time a brand manager corrected
their email (issue #98). `lib/legacyBrandEmail.ts` still recognises the email
form for backfill only — **nothing outside that module should parse a brand
email.**

### Email

Resend, not SMTP (the README used to say Nodemailer — that is gone). Templates
are plain HTML strings in `emailServices/`.

- `lib/emailSuppression.ts` — the suppression list. The address **is** the
  `_id`. Referral mail goes to people who never opted in, and the footer
  promises not to email them again; this is the mechanism that keeps it
  (issue #145).
- `lib/unsubscribeToken.ts` — signed unsubscribe links, keyed off `JWT_SECRET`
  with a domain-separation label so an unsubscribe token can never be presented
  as a session token.
- `POST /api/webhooks/resend` — bounce/complaint ingestion, Svix-verified.
  `RESEND_WEBHOOK_SECRET` is optional at boot on purpose (making it required
  would take every deployment down before the webhook is registered), and the
  route **fails closed** — unset means it rejects every delivery.

### Location capture

Shipped and merged to `main`. The pieces:

- `lib/data/locationRegistry.json` + `lib/locationRegistry.ts` — the resolver.
- `lib/evaluateLocation.ts` — versioned server-side completion truth
  (`LOCATION_COMPLETION_VERSION = 1`).
- `PATCH /api/users/location` — progressive save (dotted `$set`, legacy
  dual-writes, once-only completion stamp).
- `POST /api/location/reverse-geocode` + `lib/geocodeCache.ts` — a
  **permanent** cache with no TTL index. That is deliberate, not an oversight —
  see the comment on the schema.
- `lib/pickupSnapshot.ts` — **every future pickup writer must call
  `buildPickupAddressSnapshot`.** No pickup writer exists in any repo yet.

Open items carried from `docs/plans/HANDOFF-2026-08-25.md`:

- `LOCATIONIQ_API_KEY` is **not set in any environment**. The reverse-geocode
  route returns `{ resolved: false }` until it is. A LocationIQ attribution link
  is owed in the app (free-tier condition).
- Parked decisions before `LOCATION_GATE_MODE=hard`: coordinate-plausibility
  bound (`[0,0]` + `source: map_pin` currently counts as a pin), a rate limit on
  the PATCH endpoint, and a global LocationIQ call cap.
- Production run of `scripts/location-backfill-audit.js` is the owner's call —
  it needs prod read credentials, which have never been available. The
  `--target=production` path is gated and read-only.

---

## 7. Testing, CI, and the Express oddity

`npm test` → **345 tests across 33 suites, all passing** (verified 2026-09-04).
`npm run lint`, `npm run typecheck`, `npm run format:check` all gate CI too.

**Tests run against a real Atlas database**, `MONGODB_URI_TEST`. `jest.setup.js`
requires that variable _by name_ and remaps it onto `MONGODB_URI` — passing the
URI as `MONGODB_URI` trips a refuse-to-run guard. Every seed and migration
script has the same guard for the same reason.

CI (`.github/workflows/backend-ci.yml`) serialises every run behind a constant
`concurrency` group, because all runs share one test database and the fixtures
are not namespaced. `cancel-in-progress` stays false deliberately. There are
also `codeql.yml` (SAST, weekly cron) and `dast.yml` (ZAP).

A `main` push additionally runs a smoke test: sleep 45s for the Vercel deploy,
then `curl --fail /api/health`.

### `app.ts` is not the server

`express` is in `package.json` but **this is not an Express backend.** `app.ts`
is a thin test-harness adapter that mounts two App Router handlers for
`supertest`. Routing in production is 100% Next.js App Router.

This has bitten before: `app/api/health.ts` (Express router) passed its jest
test while `/api/health` **404'd in production**, because Vercel serves the Next
build where only `<dir>/route.ts` is a route. `app/api/health/route.ts` is what
actually serves. Read the comments in both files before adding an endpoint.

---

## 8. In flight: the MongoDB → Postgres migration

The largest open project. **Full detail is in
`docs/plans/HANDOFF-2026-09-02-postgres-migration.md`** — read it before doing
anything here. The short version:

**Done.** A normalized target schema (`docs/postgres-schema-proposal.dbml` is
the source of truth; `scripts/postgres-normalized-schema.sql` is generated from
it via `dbml2sql` and must **never** be hand-edited). A working ETL. Fixture and
scale suites. An API-response baseline recorder, and a captured golden baseline
(`baseline-mongoose.json`, 3.0 MB, 141 interactions, committed).

**The decisive facts:**

- Production is ~**7,200 users** and **1 active deal** — user-dominated. Every
  row count in the older docs came from the test cluster and misrepresents it.
- The write-freeze window is **5 seconds measured** (up to ~12 min pessimistic
  on a cross-region target). This closed the CDC / dual-write-replication fork
  and probably the maintenance-banner work too.
- **Primary keys are the Mongo ObjectId as `text`**, not integers (decided
  2026-09-03, implemented). Reason: every live JWT carries an ObjectId and
  production `JWT_EXPIRES_IN` is 30 days — longer than the 14-day dual-write
  window — so integer PKs would sign the entire user base out at switchover.
  It also keeps `_id`-derived SecureStore key names on the device stable.
- `pickups` / `pickup_items` / `collections` migrate **zero rows** in the real
  cutover. Nothing writes `pickupHistory`. The fixture work still stands as
  schema validation.

**Chosen strategy:** brief freeze → ETL → enable dual-write → unfreeze; then
dual-write for 14 days with Mongo authoritative; roll back only if captured
information is lost.

**Next steps, in the owner's priority order** (unchanged from the migration
handoff): build dual-write (fail-open, 44 write sites across 30 files) → build
the nightly reconciliation job (without it the 14-day window produces confidence
rather than evidence) → define the point of no return → per-route query rewrite
diffed against the baseline → confirm the real deal-code count → ETL enum
robustness / run atomicity → the two advisories → the deferred domain decisions
→ production Postgres tooling choice.

**Traps:**

- The ETL is **not idempotent** and the schema SQL has no `DROP`s — it must be
  applied to an empty database. Retry today means hand-making a fresh one.
- The ETL is **not transactional**. Orphaned references warn and skip;
  an unexpected **enum** value kills the run and leaves a partially loaded
  database that looks superficially fine.
- Do not join Postgres back to Mongo on `campaigns.name` — 67 names are
  duplicated in the test cluster.
- Id-prefix conventions: pickup fixtures own `e7f…`, scale fixtures own `e7e…`.
  Each script's `--drop` deletes only its own prefix. Do not break this.
- `__v`: Mongoose stamps it, a Postgres backend will not, and it will show up as
  a diff on many endpoints in the first comparison. That is a genuine API shape
  change and a decision, not noise to normalize away.

---

## 9. Known open decisions (owner's call, none blocking)

1. `campaigns` vs `deals` conflation — `campaigns` is Discount-shaped data
   wearing a recycling-programme name. Needs sign-off before the real migration.
2. No `deal_type` discriminator — every Deal is implicitly a Discount.
3. Location registry is keyed by display name, not id. Rewiring breaks a
   documented invariant and is an app-wide change.
4. Mongoose-inherited type debt — `latitude`/`longitude`, `total_collections`,
   `total_waste_collected` and every campaign/deal date stored as `text`.
5. `POST /api/brandhub/brands` — removal of org brand creation in `51da092` was
   undone by `362f255`. The endpoint is live and creating brands today. Owner
   must rule on whether `362f255` needed it or reinstated it by accident.
6. Consolidating the two parallel brand API surfaces (§2).
7. The `reset-password` enumeration advisory (§3).

---

## 10. Day-one checklist for whoever takes this over

```bash
git clone https://github.com/Mint-Rewards/Mint-Rewards-Backend.git
cd Mint-Rewards-Backend
npm install
cp .env.example .env        # then fill it — lib/env.ts will tell you what's missing
npm run typecheck && npm run lint && npm test
npm run dev                 # http://localhost:3000/api
```

Then:

- [ ] Get access: GitHub org `Mint-Rewards`, Vercel project
      `mint-rewards-backend` (team `team_c9TBpe25xW01GZU38CGH0YAH`), MongoDB
      Atlas, Resend, Vercel Blob.
- [ ] Get the **draft security advisories** — they are not visible without repo
      admin.
- [ ] Get `ADMIN_PASSWORD` from the owner. `.env` carries only the hash, and the
      API baseline recorder needs the plaintext.
- [ ] Read `docs/VOCABULARY.md` end to end. It is short and it prevents the most
      common mistake in this codebase.
- [ ] Read `lib/env.ts`. Every non-obvious operational decision is commented
      there.
- [ ] Seed a dev world: `npm run seed:personas` then `npm run dev:testdb`.
- [ ] Regenerate the knowledge graph if you use it: `graphify update .`
      (`graphify-out/` was last built 2026-08-28 and is behind).

### Scripts you will actually use

| Script                          | For                                                                     |
| ------------------------------- | ----------------------------------------------------------------------- |
| `npm run seed:personas`         | Five QA orgs, all password `test1234`. Idempotent — the frozen dataset. |
| `npm run dev:testdb`            | `next dev` pointed at `MONGODB_URI_TEST`.                               |
| `scripts/seed-brandhub-demo.js` | The demo world (refuses to run outside a db named `test_db`).           |
| `scripts/test-api.mjs --local`  | 27 end-to-end API checks. `--record <f>` captures a baseline.           |
| `scripts/api-baseline.mjs`      | `compare a b` (exits non-zero), `rules` prints the normalization rules. |

Migration tooling is inventoried in the migration handoff — everything there is
hard-locked to `*test*` URIs and requires `--yes`.

### Conventions to keep

- All Mongoose schemas live in **one file**, `lib/models.ts`, with interfaces in
  `lib/types.ts`. Infrastructure-only models that serve exactly one route
  (`lib/rateLimit.ts`, `lib/geocodeCache.ts`) are the deliberate exception.
- `lib/models.ts` **never opens the DB connection at import time.** The driver
  runs `bufferCommands: false`, so every caller must `await connectToDatabase()`
  first. Routes do it at the top of each handler.
- Path alias is `@/*` → repo root. There is no `src/`.
- No Zod, no next-auth. Validation is hand-rolled; if you want a library,
  install it deliberately.
- Comments in this codebase explain _why_, and several encode decisions that
  are not recoverable from the code. Keep that up.
