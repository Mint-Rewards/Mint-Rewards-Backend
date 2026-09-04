# Handoff — Mongo → Postgres migration (2026-09-02 → 2026-09-03)

**Status: the ETL works, the cutover strategy is chosen, and one schema
decision has been made and is being implemented.**

Companion docs: `docs/postgres-migration-plan.md` (full design/decision record),
`docs/postgres-schema-proposal.dbml` (schema source of truth),
`docs/VOCABULARY.md` (domain terms).

> **2026-09-04:** all of this is now committed and pushed on
> **`feature/postgres-migration-rehearsal`** (`b35f8a9`, `e45e51b`). `main`
> (`c59832a`) has none of it, and there is no open PR. See "State of the
> working tree" near the end — including the `format:check` failure that
> currently blocks a merge. Start at "Next steps, in priority order".

---

## Read this first — the cutover plan as it now stands

### Production shape (owner-supplied, 2026-09-03)

~**7,200 users** and **1 active deal**. This matters more than it sounds: the
test cluster's 266 deals and 26,559 `deal_codes` were test churn and badly
misrepresent the real workload, which is user-dominated.

Two consequences worth internalising before reading anything below:

- **`deal_codes` is not a high-volume table in production.** Every count in the
  "Result" section further down is from the test cluster, not from production.
- **`pickups` / `pickup_items` / `collections` will migrate ZERO rows** in the
  real cutover. `pickupHistory` is empty on every real user and no route
  handler in either repo writes it. The fixture work below still stands — it
  validates that part of the schema for when a writer appears, and it caught
  the `legacy_brand_id` two-pass bug — but it is **not on this cutover's
  critical path**.

### The write-freeze window is 5 seconds (measured, not estimated)

The ETL is a point-in-time snapshot: any write landing in Mongo after it reads
a collection is silently lost. The freeze is the entire data-loss protection,
and its length is the ETL's runtime.

Measured against a synthetic production-shaped dataset
(`scripts/seed-etl-scale-fixtures.mjs`, 7,200 users + realistic child-table
ratios, ~13,800 insert round-trips):

```
users 7200 · user_otp_flows 2400 · user_referrals 1800
user_locations 1440 · deal_codes 1000 · orphaned rows 0
exit 0 · 0 warnings · elapsed 5s   (local Postgres, reading from Atlas)
```

The ETL awaits one round-trip per row, so runtime scales with latency to the
**target** Postgres, not with cleverness:

| Target Postgres     | Round-trip | Freeze window      |
| ------------------- | ---------- | ------------------ |
| Local / same host   | <1 ms      | **5 s** (measured) |
| Same-region managed | ~5 ms      | ~70 s              |
| Cross-region        | ~20 ms     | ~5 min             |
| Pessimistic         | ~50 ms     | ~12 min            |

Even the worst case fits a 15-minute window. The user base is Pakistan-only
(single timezone), so a 3–4am PKT window has enormous margin. **Conclusions:
do not build CDC or dual-write-based replication for the initial load, and the
server-driven maintenance-banner work is probably unnecessary** — at this
window length in the dead of night, active users are effectively zero.

### Chosen strategy (owner, 2026-09-03)

1. Brief freeze → run the ETL → enable dual-write → unfreeze.
   (Enabling dual-write _before_ the ETL races it; _after_ loses the writes in
   between. The 5-second freeze is what makes this ordering safe and cheap.)
2. **Dual-write to Mongo and Postgres for 14 days**, Mongo authoritative.
3. **Roll back to Mongo only if information currently being captured is lost.**
4. If the window passes cleanly, transition to 100% Postgres.

Three requirements this strategy imposes, none yet implemented:

- **Dual-write must fail open.** A Postgres write error must never fail the
  user's request while Mongo is authoritative — log and continue. Otherwise the
  failure surface doubles on behalf of a database no user depends on yet.
- **"Successful" needs a daily definition, not a day-14 one.** Dual-write
  diverges silently; a failed shadow write leaves no trace in the user-visible
  path. Without nightly reconciliation the rollback trigger is unfalsifiable,
  because loss nobody is looking for is loss nobody sees. The comparison logic
  in `scripts/verify-etl-fixtures.mjs` is the starting point; it needs
  generalising into a scheduled job.
- **Implementation surface, measured:** 44 write operations across 30 route
  files, over 7 Mongoose methods (`.create` 12, `.findOneAndUpdate` 9, `.save`
  8, `.updateOne` 5, `.findByIdAndUpdate` 5, `.findOneAndDelete` 4,
  `.findByIdAndDelete` 1). Only 8 are `.save()`, so document middleware alone
  will not cover it — query middleware is needed too, and the dotted-`$set`
  updates need translating to columns.

### DECISION: the ObjectId becomes the Postgres primary key

**Decided 2026-09-03. Being implemented now.** Full comparison with the
measured costs of both options:
<https://claude.ai/code/artifact/aa58819c-fda1-4d89-893b-409e4a498647>

**The problem.** The target schema used `INTEGER GENERATED BY DEFAULT AS
IDENTITY` primary keys and retained **no** column holding the original Mongo
`_id` anywhere. The one-shot ETL built that mapping in memory and discarded it.
Dual-write cannot resolve a reference without it — and worse:

- Every signed-in user's JWT carries a Mongo ObjectId as its subject
  (`{"id":"6a985811cf8c5c4aa3f43823", ...}`) and `JWT_EXPIRES_IN=30d`, i.e.
  **longer than the 14-day window**. On switchover day every active session
  presents an ObjectId. If Postgres cannot resolve it, the app's global 401
  handler signs the entire user base out at once.
- The app bakes `user._id` into persisted SecureStore key _names_ —
  `demoScheduledCollection_<_id>` (`store/store.ts` ~L459) and
  `appleFullName_<id>`. Both deliberately survive logout, and the Apple one is
  unrecoverable because Apple returns `fullName` exactly once.

So the id mapping is not an ETL convenience. It is what keeps the switchover
invisible to users.

**Scope of the problem is smaller than it first appears:** of 30 tables, only
**11** correspond to real Mongo collections and therefore have an ObjectId at
all (`organizations`, `brandthemes`, `locations`, `users`, `captains`,
`logistics`, `brands`, `campaigns`, `collections`, `deals`, `brandusers`). The
other 19 are decomposed from embedded arrays whose sub-documents are declared
`_id: false`.

**The two options, measured against this codebase:**

| Dimension                       | A — add `legacy_mongo_id` column        | B — ObjectId as PK (**chosen**)        |
| ------------------------------- | --------------------------------------- | -------------------------------------- |
| Schema churn                    | 11 columns + 11 unique indexes          | 11 PKs + 29 FK columns retyped         |
| ETL                             | +11 lines; remap layer kept forever     | −34 remap call sites deleted           |
| API rewrite surface             | ~71 lookup sites need translation       | **0**                                  |
| Existing JWTs at switchover     | resolvable only if every path converted | valid unchanged                        |
| SecureStore keys                | stable only by discipline               | stable by construction                 |
| Response contract               | preserved only by discipline            | identical by construction              |
| Dual-write reference resolution | a lookup per reference                  | none needed                            |
| Storage / join cost             | 4-byte keys                             | 24-byte keys — negligible at 7.2k rows |
| Failure mode if botched         | **silent** — wrong id reaches a device  | **loud** — schema won't load           |

**Why B.** Its cost lands in DDL, where mistakes fail loudly; option A's cost
lands in application code, where a leaked integer id reaches a user's device
and fails silently. `getAuthenticatedUserId()` already returns a _string_ (the
ObjectId lifted from the JWT), so against a `text` primary key
`WHERE id = $1` works with **zero** change to auth — which is most of why the
API column reads 0. The integer PK is a normalisation instinct that buys
nothing measurable at 7,200 rows.

**The usual objection, and why it does not apply here.** "What mints ids once
Mongo is switched off?" Postgres has no native ObjectId generator — but
ObjectId generation is entirely client-side (4-byte timestamp, 5-byte random,
3-byte counter; no server round-trip, no Mongo instance). Keeping
`new mongoose.Types.ObjectId().toString()` as the id factory works with Mongo
decommissioned and keeps every id in the system one shape forever. This also
preserves an assumption already written into the code: 5 route files validate
with `isValidObjectId`. The `gen_random_uuid()` alternative would break it.

**Known cost of B, accepted:** it invalidates the ETL's id-remapping layer, so
the fixture and scale suites must be re-run afterward. Cheap — both suites
exist and a full run is 5 seconds — but not free.

**Correction to an earlier claim.** The comparison originally said B removes the
need for the two-pass `legacy_brand_id` resolution. **It does not.** With
ObjectId PKs the _value_ is known at insert time, but the FK target row must
still EXIST when the row is inserted, and Mongo cursor order is arbitrary. The
constraint is `DEFERRABLE INITIALLY IMMEDIATE` and the ETL runs no transaction,
so deferral never engages. The two-pass is retained and still required.

### Implementation status — DONE, verified 2026-09-03

| Change                                             | Detail                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/postgres-schema-proposal.dbml`               | 11 PKs → `id text [pk]`; 29 FK columns `integer` → `text`. Both counts derived from the `Ref:` block programmatically, not hand-listed.                                                                                                                           |
| `scripts/postgres-normalized-schema.sql`           | Regenerated via `dbml2sql` (never hand-edited), project header restored. 17 integer identity PKs remain — the non-Mongo tables. All 33 FKs preserved.                                                                                                             |
| `scripts/migrate-mongo-to-postgres-normalized.mjs` | `idMaps` (Maps) → `known` (Sets) + a `ref()` helper. 8 registrations and 12 lookups rewritten; 11 entity inserts now write an explicit `id`; `insertReturningId` retained only for the 4 integer-PK tables (`cities`, `brand_environmental_stats` ×2, `pickups`). |

**The `idMaps`→Sets detail matters:** those maps were doing two jobs, and only
one of them disappeared. Remapping is gone; **orphan detection is not**. Every
`ref()` still answers "does this document exist?", so a dangling reference is
still warned about and skipped rather than inserted as an FK violation that
would abort the run. Collapsing the lookups to a bare pass-through would have
silently converted every orphan warning into a run-killing constraint error.

**Verification after the change:**

- Fixture suite: ETL exit 0, **20/20 assertions pass**, the same 5 deliberate
  warnings, row counts identical to the integer-PK run. The two-pass assertion
  now reads `child.legacy_brand_id=e7f…005 parent.id=e7f…005` — the ObjectId
  carried across verbatim.
- Scale suite (7,200 users): exit 0, **6s**, 0 warnings, counts identical to
  the integer-PK run. **7,200 of 7,200** ids match `^[0-9a-f]{24}$`, 0 orphaned
  child rows, `users.id` is `text`.
- One bug caught by re-running rather than by reading: `brandthemes` and
  `logistics` are entity tables that use `insertRow` rather than
  `insertReturningId`, so they were missed by the first conversion pass and
  relied on the now-removed integer identity. Fixed; a completeness check over
  all 11 entity tables now confirms each writes an explicit `id`.

---

## The 2026-09-02 verification run, and how to reproduce it

```bash
cd Mint-Rewards-Backend

# 1. Fresh throwaway target (the ETL is NOT idempotent, and
#    postgres-normalized-schema.sql contains no DROP statements —
#    it must be applied to an empty database).
createdb mint_rewards_verify_test
PG='postgres://<user>@localhost:5432/mint_rewards_verify_test'
psql "$PG" -f scripts/postgres-normalized-schema.sql       # 30 tables, 33 FKs

# 2. Dry run (no --yes) — prints redacted source/target and exits 0.
node scripts/migrate-mongo-to-postgres-normalized.mjs

# 3. Real run.
POSTGRES_URL_TEST="$PG" node scripts/migrate-mongo-to-postgres-normalized.mjs --yes
```

Both `MONGODB_URI_TEST` and `POSTGRES_URL_TEST` are already present in `.env`.
The script is hard-locked to URIs with `test` in the db name — any override you
pass must keep that (`mint_rewards_verify_test` passes; `..._test2` would not).

## Result

- **Exit code 0.** Schema applied with zero errors: 30 tables, 33 foreign keys.
- **125 warnings, 0 errors.** All are orphaned-reference skips: 16 campaigns and
  13 deals whose `brand` ObjectId no longer resolves, plus `campaigns.users[]` /
  `deals.users[]` / `deals.claims[]` entries pointing at deleted users. Each was
  skipped rather than crashing the run or corrupting a row — which is the
  designed behaviour. Read as test-cluster churn, not an ETL defect.

### Row counts loaded

| Table                                  | Rows |     | Table                   | Rows   |
| -------------------------------------- | ---- | --- | ----------------------- | ------ |
| users                                  | 42   |     | deals                   | 266    |
| organizations                          | 28   |     | deal_codes              | 26,559 |
| organization_module_subscriptions      | 82   |     | deal_users              | 9      |
| brands                                 | 28   |     | deal_claims             | 9      |
| brandusers                             | 29   |     | campaigns               | 262    |
| brand_user_module_access               | 3    |     | campaign_addresses      | 201    |
| brand_environmental_stats              | 31   |     | campaign_discount_codes | 203    |
| brand_environmental_material_breakdown | 118  |     | user_locations          | 9      |
| user_referrals                         | 11   |     | user_otp_flows          | 13     |

### Integrity assertions (all passed)

- `users` 42/42, `organizations` 28/28, `brands` 28/28, `brandusers` 29/29,
  `user_referrals` 11/11, `organization_module_subscriptions` 82/82 —
  exact matches against Mongo.
- `campaigns` 262 of 278 and `deals` 266 of 279 — the deltas are exactly the
  16 + 13 orphaned-brand skips logged as warnings. Recomputed independently
  from Mongo (filtering to deals/campaigns whose brand actually exists): 262
  and 266. Exact.
- `deal_codes` 26,559 — matches the sum of `codes[]` over surviving deals
  after per-deal dedup, exactly. (Raw sum over _all_ deals is 28,919; the
  2,360 difference is entirely codes belonging to the 13 skipped deals.)
- `campaign_addresses` 201/201 and `campaign_discount_codes` 203/203 against
  the surviving campaigns.
- **Content, not just counts:** the full multiset of every
  `campaign_addresses` row (`province|city|town`) and every
  `campaign_discount_codes` row was compared against the Mongo source —
  **byte-identical** in both cases.

> Note for whoever verifies next: do **not** join Postgres back to Mongo on
> `campaigns.name`. 67 campaign names are duplicated in the test cluster and
> the normalized schema keeps no `legacy_mongo_id` column on `campaigns`, so a
> name join silently merges several campaigns' children and produces false
> mismatches. Compare multisets (as above), or add an ordinal.

## Pickup / collection coverage — CLOSED (2026-09-02, later same day)

Previously the largest gap: `pickups`, `pickup_items`, `collections`,
`collection_users`, `collection_captains`, `cities`, `towns` all loaded **0
rows** from the real test cluster, so the decomposition that fixes the
un-remapped-ObjectId bug — the main reason this schema exists — had synthetic
coverage only.

**Why waiting would never have closed it:** `pickupHistory` is written by
_nothing_. It appears in `lib/models.ts`, `lib/types.ts`, `lib/pickupSnapshot.ts`,
the migration scripts and the tests, and in **zero route handlers** — consistent
with `HANDOFF-2026-08-25.md` ("no pickup writer exists in any repo yet"). The
test cluster was never going to accumulate this data. So the gap is closed
deliberately, with fixtures.

### New tooling

| File                                   | Purpose                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/seed-etl-pickup-fixtures.mjs` | Seeds the Mongo-side fixtures. Deterministic `_id`s under prefix `e7f`, so it is idempotent and `--drop` removes exactly its own documents and nothing else. `--yes` to seed, no flag for a dry run that prints the plan. |
| `scripts/verify-etl-fixtures.mjs`      | 20 content assertions against the loaded Postgres. Exits non-zero on failure, so it can gate CI.                                                                                                                          |

Uses the raw `mongodb` driver rather than Mongoose (unlike `seed-brandhub-*.js`)
because two fixtures are _defined by_ what Mongoose would not permit: an
`addressSnapshot` that is genuinely absent, and `latitude`/`longitude` explicitly
`null`. Mongoose defaults would coerce both into uselessness.

### How to run it

```bash
# Seed into a DEDICATED database — not the shared mint-rewards-test, which
# churns under other work. The name must still contain "test" for the guards.
FIX='mongodb+srv://.../mint-rewards-etl-test?appName=Cluster0'
ETL_FIXTURES_MONGODB_URI="$FIX" node scripts/seed-etl-pickup-fixtures.mjs --yes

createdb mint_rewards_fixtures_test
PG='postgres://<user>@localhost:5432/mint_rewards_fixtures_test'
psql "$PG" -f scripts/postgres-normalized-schema.sql

MONGODB_URI_TEST="$FIX" POSTGRES_URL_TEST="$PG" \
  node scripts/migrate-mongo-to-postgres-normalized.mjs --yes
MONGODB_URI_TEST="$FIX" POSTGRES_URL_TEST="$PG" \
  node scripts/verify-etl-fixtures.mjs
```

### Result: exit 0, **20/20 assertions pass**, 5 warnings — all deliberate

Every row count matched the seeder's predicted deltas exactly (the seeder
derives its predictions _from_ the fixtures, so the two cannot silently
disagree): `pickups` 4, `pickup_items` 6, `collections` 2, `collection_users` 2,
`collection_captains` 2, `cities` 2, `towns` 5, `brands` 3, `users` 4,
`captains` 2, `logistics` 1, `brandthemes` 1, `locations` 1.

What the assertions actually prove, beyond counts:

- **`legacy_brand_id` two-pass resolution works** — now exercised for the first
  time. The child brand is deliberately allocated an earlier `_id` than its
  parent, so a naive single-pass insert would fail; the child resolved to the
  parent's real integer id, and a dangling `legacyBrandId` was left NULL with a
  warning instead of aborting.
- **FKs remapped to the right rows** — the pickup's `collection_id` and
  `captain_id` resolve back to the correct named documents, not merely to
  _some_ row.
- **GeoJSON `[lng, lat]` lands in the right columns, unswapped** — the failure
  mode that reconciles perfectly on counts and is silently wrong.
- **`pickup_items` reconstruct exactly** — order, codes and weights, including a
  zero weight.
- **Pre-P0.4a pickups migrate** with every `snapshot_*` column NULL (those
  columns are deliberately nullable with no default: NULL distinguishes "predates
  snapshots" from "snapshot taken, field empty").
- **Snapshot with `location` but no `coordinates`** → lng/lat NULL, enums still
  set; and a pickup with **zero** items still produces its parent row.
- **Both dangling-ref pickups skipped cleanly** — no half rows, and their QR
  items were not orphaned into `pickup_items`.
- **Regression lock on the explicit-null bug** that failed the first real-data
  run: `latitude`/`longitude` of `null` fall back to the `NOT NULL DEFAULT ''`.
  If that fix is ever regressed, this fixture fails the run.

## Finding: the ETL is not transactional, and aborts hard on a bad enum

Surfaced while building the fixtures (an invalid `snapshotSource` value). Worth
recording because it is a **cutover risk, not a fixture problem**:

- Orphaned references warn and skip. **Unexpected enum values do not** — Postgres
  rejects the insert and the whole run dies with a stack trace.
- Nothing wraps the run in a transaction, so the abort left a **partially loaded
  database**: 4 users, 3 brands and 2 collections committed, 0 pickups, exit 1.

On a real cutover against legacy data, one unexpected enum value anywhere
(`status`, `role`, `snapshot_source`, `location.source`, `precision`) produces a
half-migrated database that looks superficially fine. Two options, neither yet
chosen: wrap the run in a single transaction so it is all-or-nothing, or
pre-validate every enum-backed field the way `scripts/audit-mongo-shape.mjs`
pre-validates structural shape. The second is cheaper and matches the existing
pre-flight pattern.

## Query parity — baseline recorder built (2026-09-02)

The acceptance test for this migration is a response diff, not a row count: the
mobile app only talks to this backend over HTTP. The recorder captures a golden
baseline from the current Mongoose backend so a Postgres-backed one can be
diffed against it. **Capture this while exactly one implementation exists** —
once the rewrite starts, a clean "before" is no longer available.

| File                                       | Purpose                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/lib/api-baseline.js`              | Normalizer + comparator. The rules are documented in its header and are the reviewable surface of this work.                   |
| `scripts/test-api.mjs --record <file>`     | Records a baseline. ~15 lines tapping the single `call()` chokepoint every one of its 27 test functions already flows through. |
| `scripts/api-baseline.mjs compare <a> <b>` | Diffs two baselines. Exits non-zero, so it can gate a cutover. `rules` subcommand prints the normalization rules.              |
| `__tests__/apiBaseline.test.ts`            | 28 tests, one per rule. Runs in `npm test`.                                                                                    |

### How to use it

```bash
node scripts/seed-brandhub-personas.js        # freeze the dataset FIRST
npm run dev:testdb                            # server against the test DB
ADMIN_EMAIL=... ADMIN_PASSWORD=... \
  node scripts/test-api.mjs --local --record baseline-mongoose.json
# ...later, against the rewritten backend...
node scripts/api-baseline.mjs compare baseline-mongoose.json candidate-postgres.json
```

Seed first, and always from the same seed. A baseline captured against the raw
shared test cluster is worthless because that cluster churns under other work.
`seed-brandhub-personas.js` is idempotent by design ("re-running deletes each
persona org and everything hanging off it, then recreates it") — that is the
frozen dataset.

### The normalization rules, and why they are the real work

A raw response can never be compared across two databases, but blanking
everything volatile discards exactly what a migration gets wrong. Each rule is
a trade-off:

1. **Ids become stable symbols, not blanks.** A Mongo ObjectId becomes a
   Postgres integer — never equal, so a naive diff is useless, and blanking to
   `<id>` would hide the most important bug class: _a reference pointing at the
   wrong row_. Instead each distinct id becomes `<id:N>`, numbered by first
   appearance across the whole capture, preserving **referential structure**
   while discarding representation. Un-remapped ObjectIds, off-by-one id maps
   and cross-linked rows all surface as a symbol mismatch. This is the main
   reason to normalize rather than blank.
2. **Secrets → `<token>`.** JWTs embed `iat`, so they differ every run.
3. **Server-stamped dates → `<timestamp>`; domain dates KEPT.** `createdAt` is
   an artifact of when the test ran; `startDate`/`endDate` are data — and this
   schema stores every one of them as `text` (known type debt), so a migration
   that mangles them must fail the diff. Separated by an explicit field list,
   not a "looks like a date" regex.
4. **Per-run generated identity → `<generated>`.** Only the `Date.now()+uuid`
   suffix is stripped, so a change to the stable part still shows up.
5. **Array order preserved, never sorted.** Sorting is the tempting bug: Mongo
   natural order and Postgres unordered-SELECT order genuinely differ and the
   app renders some lists directly, so an order change is a finding to rule on,
   not noise to suppress.
6. **Absent ≠ null ≠ empty.** Key _order_ is normalized; key _presence_ is not.
   The ETL already produced one real bug in exactly this seam (explicit null
   defeating a `NOT NULL DEFAULT`), so collapsing them would blind the diff to
   its recurrence at the API layer.

### Verified end to end

- 28 unit tests pass, one per rule, including the negative cases (a cross-linked
  reference and a mangled domain date both correctly _fail_ the diff).
- Recorded live against `npm run dev:testdb`: two independent runs compare clean
  (exit 0); an injected status change and an added field are both caught
  (exit 1).
- Recording a real `/users/signup` confirmed every rule on genuine output —
  `_id` → `<id:1>` consistently across responses, JWT → `<token>`, `created` →
  `<timestamp>`, the run suffix stripped from email and userName, and
  `latitude: null` preserved as null rather than collapsed.

**Two things the live recording caught that unit tests alone would not have:**

1. **A secret leak.** `confirmPassword` was written to the baseline in
   plaintext — `password` was redacted, its alias was not. Baselines are files
   people commit and share. Fixed, with `newPassword`/`oldPassword`/
   `currentPassword` added at the same time, and a regression test.
2. **`process.exit(1)` discarded the whole capture.** Several helpers in
   `test-api.mjs` exit early when a precondition fails (no admin token). The
   write now runs from a `process.on("exit")` hook and labels the result
   `PARTIAL`, so an aborted run yields a usable, clearly-marked capture instead
   of nothing.

### Known expected diff — do not normalize it away

Mongoose stamps `__v` on every document and it surfaces in responses returning
raw documents. A Postgres backend will not emit it, so it will show up as a
diff on many endpoints in the very first comparison. That is a genuine API
shape change and a decision for whoever does the rewrite (keep emitting it, or
drop it and confirm no client reads it) — surfaced deliberately, not stripped.

### Baseline CAPTURED — 2026-09-03

Run by the owner (who holds `ADMIN_PASSWORD`; `.env` carries only
`ADMIN_PASSWORD_HASH`). Output: **`baseline-mongoose.json`** in the repo root,
3.0 MB, **141 interactions**, `complete: true`, **652 distinct ids symbolised**.

**Safety-scanned before use:** 0 JWTs, 0 bcrypt hashes, 0 plaintext passwords.
The only values remaining under sensitive-looking keys are deliberate test junk
(`"x"`, `"not.a.valid.jwt"`, `"clearly-not-a-real-google-token"`) and empty
`deviceToken` strings.

**The file is untracked.** Committing it is right — it is the reference
artifact — but it is 3.0 MB and that is a deliberate call to make, not an
accident.

**One hardening came out of scanning it:** `resetToken`, `idToken` and
`identityToken` were not redacted by name. In this capture they held only junk,
but a real password-reset token need not be JWT-shaped (so the shape-based
fallback misses it) and a real Google/Apple `idToken` is a live credential.
Now redacted by name, with a test. `mintId` was also moved into the id-symbol
rule: it is regenerated per signup, so comparing its literal value was
permanent diff noise, while symbolising it still catches a mintId that changes
_within_ a run.

**Baselines record behaviour as-is, not as-should-be.** This one contains the
`reset-password` enumeration defect below. If that is fixed before the Postgres
rewrite, the diff will correctly flag it — re-record, or note it as an expected
diff alongside `__v`.

## Still unverified

- ~~**Volume.**~~ Closed 2026-09-03: `scripts/seed-etl-scale-fixtures.mjs`
  generates a production-shaped dataset and the ETL was run against 7,200
  users. What remains genuinely unverified is _performance under production
  indexes_, not correctness at volume — and that stays unmeasurable until
  there is real traffic behind it (see the performance note in Next steps).
- **Real-world pickup shapes.** These fixtures encode what the _schema_ permits.
  If a pickup writer is ever built, re-check its actual output against them —
  the fixtures are a model of the contract, not evidence about production data.

## Drift noticed since the last recorded run

The test cluster shrank: the previous run (also 2026-09-02, recorded in
`docs/postgres-migration-plan.md`) saw **90 users / 107 warnings**; today it is
**42 users / 125 warnings**. The cluster is being actively created and deleted
against, so treat any specific count in these docs as a snapshot, and re-run
the reconciliation rather than trusting a recorded number.

## Environment notes

- Postgres is **Homebrew-local Postgres 16** on `localhost:5432`, not Docker.
- `mint_rewards_migration_test` (the previous run's target) is still populated
  and was left untouched. Today's run used a new database,
  `mint_rewards_verify_test`, which is also still present — drop both when
  they're no longer wanted (`dropdb`).
- Run logs, if still on disk: `<scratchpad>/etl-run.log` (real cluster),
  `fixture-run.log`, `pk-fix.log` (fixtures on the new schema), `scale.log` and
  `scale2.log` (7,200-user runs before/after the PK change).
- **Disposable databases created across 2026-09-02→03.** None are needed; drop
  them freely.

  | Kind     | Name                          | Purpose                                                            |
  | -------- | ----------------------------- | ------------------------------------------------------------------ |
  | Postgres | `mint_rewards_migration_test` | the original run's target                                          |
  | Postgres | `mint_rewards_verify_test`    | 2026-09-02 re-verification                                         |
  | Postgres | `mint_rewards_fixtures_test`  | pickup/collection fixtures                                         |
  | Postgres | `mint_rewards_scale_test`     | 7,200-user scale runs                                              |
  | Mongo    | `mint-rewards-etl-test`       | pickup fixtures — `seed-etl-pickup-fixtures.mjs --drop` empties it |
  | Mongo    | `mint-rewards-scale-test`     | scale fixtures — `seed-etl-scale-fixtures.mjs --drop` empties it   |

  Both Mongo databases live on the same Atlas cluster as `mint-rewards-test`.
  They exist so fixture runs never pollute the shared test cluster, whose churn
  is what made earlier counts unreproducible.

## Findings from the captured baseline (2026-09-03)

The baseline capture (141 interactions, `complete: true`, 652 ids symbolised)
was run by the owner against `npm run dev:testdb`. It surfaced defects that are
**unrelated to the migration** but were found by this tooling. Recorded here so
they are not lost; none of them block the cutover.

### Security — two private GitHub advisories filed

The repo is PUBLIC, so these were filed as **draft security advisories** rather
than issues. Draft = visible only to repo admins, nothing disclosed. Convert to
public advisories once fixed.

- **[GHSA-hrfp-f4qf-8c39]** · MEDIUM · user enumeration via
  `POST /api/users/reset-password`. Unknown email returns
  `404 {"code":"ACCOUNT_NOT_FOUND", ...}`; a registered one returns
  `200 {"message":"A reset code has been sent."}`. Unauthenticated, no
  side effects, trivially scriptable. **This is a defect, not a design
  choice** — `scripts/test-api.mjs` already asserts one generic `200` for both
  cases and has been failing on it, and `/users/login`, `/admin/login`,
  `/brandhub/auth/login` and `/users/verify-otp` all implement the generic
  response correctly. Fix: identical status and body for both branches, send
  the mail only in the exists-branch, and watch that response _timing_ does not
  reintroduce the oracle.
- **[GHSA-7xqq-85f9-9r5m]** · LOW · account/brand enumeration via the three
  registration endpoints (`/users/signup`, `/brandhub/auth/register`,
  `/brands/register`) returning `409` on a known identity. Filed as a decision
  rather than a defect — a registration endpoint cannot silently accept a
  duplicate. Options laid out in the advisory, cheapest being rate-limiting
  (`lib/rateLimit.ts` already exists). Note `/brands/register` additionally
  leaks whether a **company registration number** is on file, a second
  identifier class that is often public.

### `/brandhub/modules/:module` tests — FIXED

The tests used module ids `b2c` and `analytics`, neither in
`MODULE_CATALOGUE` (`consumer-reporting`, `esg`, `minttrace`), so they 404'd on
the id check and never reached the logic they claimed to test.

A name swap alone was insufficient: commit `51da092` also made _all modules
active for new orgs_, so `POST /brandhub/auth/register` subscribes an org to
every module and the `402 no subscription` branch is now **unreachable over
HTTP**. Reaching it needs a subscription deliberately removed — direct DB
manipulation this runner does not do.

The two `402` assertions were therefore rewritten to assert the reachable
contract (subscribed access → `200`), with an in-file comment recording that
the `402` path is deliberately untested here rather than silently dropped.
Verified against a live server:

```
unknown module, no auth  → 404 ✓
valid module, no auth    → 401 ✓
GET  authed, subscribed  → 200 "read access confirmed"  ✓
POST authed, subscribed  → 200 "write access confirmed" ✓
```

### `POST /brandhub/brands` — a regression, NOT a stale test

The test asserts `405` ("brand creation under an org is no longer exposed") and
gets `201`. The owner confirms the removal was deliberate. `git show` shows it
was undone:

- `51da092` _"...remove org brand creation"_ — **deleted** `export async function POST`
- `362f255` _"Make BrandHub-authored brands and campaigns work in the app"_ — **re-added it**

The endpoint is live and creating brands today. **Left untouched** — restoring
the removal is a behaviour change on a route that later work may now depend on,
and needs an owner ruling on whether `362f255` required it or reinstated it by
accident.

## State of the working tree — COMMITTED (updated 2026-09-04)

> **This section is superseded.** When it was written everything was
> uncommitted on `main`. It has since been committed and pushed to the branch
> **`feature/postgres-migration-rehearsal`** as two commits:
>
> - `b35f8a9` — normalized schema + migration scripts
> - `e45e51b` — ETL fixture seeders, verifier, API-baseline tooling, and
>   `baseline-mongoose.json` (the 3.0 MB golden baseline; committing it was the
>   deliberate call flagged below)
>
> `main` is `c59832a` and does **not** contain any of it. The branch is pushed
> and has no open PR. Whoever picks this up inherits a clean tree on that
> branch, not a dirty tree on `main`.
>
> Two things to know before opening a PR from it:
>
> - `npm run format:check` **fails** on this branch — Prettier flags
>   `baseline-mongoose.json`, `docs/postgres-migration-plan.md`, four migration
>   scripts and the four vendored `scripts/vendor/mongo-to-postgres/` files.
>   CI gates on `format:check`, so this blocks the merge. The vendored
>   directory probably belongs in `.prettierignore` (it already excludes
>   "generated or vendored" paths for exactly this reason).
> - `npm test` (345/345), `npm run lint` (0 errors, 34 warnings) and
>   `npm run typecheck` all pass on the branch — re-verified 2026-09-04.

The file lists below remain accurate as a description of _what_ the two commits
contain.

**Modified (5):**

| File                                               | What changed                                                    |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `docs/postgres-schema-proposal.dbml`               | 11 PKs → text ObjectId, 29 FK columns → text                    |
| `scripts/postgres-normalized-schema.sql`           | regenerated from the DBML (never hand-edit)                     |
| `scripts/migrate-mongo-to-postgres-normalized.mjs` | remap layer → existence sets; explicit ids on 11 entity inserts |
| `scripts/test-api.mjs`                             | `--record` baseline tap; `/brandhub/modules` tests fixed        |
| `docs/postgres-migration-plan.md`                  | status updates + stale-DDL warning at the top                   |

**New, untracked (8):**

| File                                                  | What it is                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/plans/HANDOFF-2026-09-02-postgres-migration.md` | this document                                                             |
| `scripts/seed-etl-pickup-fixtures.mjs`                | pickup/collection/legacy-brand fixtures (`e7f` id prefix)                 |
| `scripts/verify-etl-fixtures.mjs`                     | 20 content assertions over a fixture-fed run                              |
| `scripts/seed-etl-scale-fixtures.mjs`                 | production-shaped scale generator (`e7e` id prefix)                       |
| `scripts/lib/api-baseline.js`                         | response normalizer + comparator (CommonJS, per repo convention)          |
| `scripts/api-baseline.mjs`                            | `compare` / `rules` CLI                                                   |
| `__tests__/apiBaseline.test.ts`                       | 28 tests, one per normalization rule                                      |
| `baseline-mongoose.json`                              | the captured golden baseline, 3.0 MB — committing it is a deliberate call |

**Verification at time of writing:** `npm test` 345/345 · `npm run lint` 0
errors (34 pre-existing warnings, none in the new files) · `tsc --noEmit`
clean · fixture suite 20/20 · scale suite 7,200 users in 6s.

One flaky `npm test` failure was observed once, in a command that also ran
`pkill` against the dev server; it did not reproduce across two subsequent
clean runs. Not investigated further — noted so it is not mistaken for a real
regression.

## Complete tooling inventory

Everything built across 2026-09-02→03, and what each is for.

| Script                                     | Use it when                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `migrate-mongo-to-postgres-normalized.mjs` | the ETL itself. Hard-locked to `*test*` URIs, requires `--yes`, not idempotent                                       |
| `audit-mongo-shape.mjs`                    | read-only pre-flight: real Mongo array/sub-document shapes vs the ETL's assumptions                                  |
| `seed-etl-pickup-fixtures.mjs`             | seed the shapes real data cannot supply (pickups, collection joins, forward `legacyBrandId`, explicit-null lat/long) |
| `verify-etl-fixtures.mjs`                  | assert a fixture-fed run is _correct_, not merely complete. Exits non-zero                                           |
| `seed-etl-scale-fixtures.mjs`              | generate production-shaped volume to time the freeze window                                                          |
| `test-api.mjs --record <f>`                | capture an API baseline from a running backend                                                                       |
| `api-baseline.mjs compare a b`             | diff two baselines. Exits non-zero. `rules` prints the normalization rules                                           |

**Two id-prefix conventions worth not breaking:** pickup fixtures own `e7f…`,
scale fixtures own `e7e…`. Each script's `--drop` deletes only its own prefix
range, so the two never collide and neither can touch real data.

## Next steps, in priority order

Re-ordered 2026-09-03 around the owner's stated priority: a seamless
transition with no user disruption and no data loss.

1. **Switch the schema to ObjectId primary keys** (the decision above) and
   simplify the ETL accordingly, then re-run the fixture and scale suites.
   _In progress._ Everything else in the dual-write plan depends on it.
2. **Build dual-write**, fail-open, Mongo authoritative. 44 write sites / 30
   files; Mongoose query + document middleware is the least invasive route.
3. **Build the nightly reconciliation job.** Without it the 14-day window
   produces confidence rather than evidence, and the rollback trigger cannot
   fire. Generalise `scripts/verify-etl-fixtures.mjs`.
4. **Define the point of no return.** Rollback is free while Mongo is
   authoritative and nothing writes only to Postgres. After the switch to 100%
   Postgres, rolling back loses every Postgres-side write. Decide the trigger
   and the deadline in advance.
5. **Query parity.** Baseline is captured; the remaining work is the per-route
   rewrite and diffing against it. Note the decision above should make ids diff
   clean rather than differing on every single one.
6. **Confirm the real deal-code count** and re-run the scale test. The `1000`
   in `seed-etl-scale-fixtures.mjs` is a guess and is the main remaining lever
   on total row count. The ETL migrates _every_ deal regardless of status, so
   what matters is the total deal count, not the 1 active one.
7. **Enum robustness / run atomicity.** Lower stakes now that a failed run
   costs 5 seconds to redo — but the _reset path_ matters under a live window
   (`postgres-normalized-schema.sql` has no `DROP`s and the ETL is not
   idempotent, so retry currently means hand-making a fresh database).
8. **Fix the two security advisories** — unrelated to the migration, tracked
   privately, not blocking.
9. **Owner decisions still open** — `campaigns` vs `deals` conflation, missing
   `deal_type` discriminator, name-keyed location registry, Mongoose-inherited
   type debt. See "Explicitly deferred" in `docs/postgres-migration-plan.md`.
10. **Production tooling choice** — becomes urgent when step 5 starts, since
    that is when production-shaped Postgres query code first gets written.
11. **Performance sanity** — deprioritised. At 7,200 users the planner will
    seq-scan regardless and `EXPLAIN ANALYZE` teaches nothing until there is
    production-scale volume behind the indexes.

## Superseded guidance (do not act on)

- _"Get a real dataset with populated `pickupHistory`"_ — impossible; nothing
  writes it. Closed with fixtures instead.
- _"Start the server-driven maintenance banner early because it is the long
  pole"_ — written before the 5-second measurement. At that window length the
  whole apparatus is probably unnecessary.
- _"Consider CDC / dual-write replication for a near-zero-downtime cutover"_ —
  the measurement closed this fork. A brief freeze is sufficient. (The 14-day
  dual-write in the chosen strategy is a _verification_ mechanism after the
  initial load, not a replication strategy for it.)
