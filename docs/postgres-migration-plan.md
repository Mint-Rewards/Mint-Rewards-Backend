# Postgres migration plan: normalization + verification status

Tracks the effort to design a normalized Postgres target schema for the
eventual MongoDB → Postgres migration, and to verify it actually works
before it's used for a real cutover. Companion to `docs/VOCABULARY.md`
(domain terms) and `docs/postgres-schema-proposal.dbml` (the schema itself).

## Why this exists

`scripts/migrate-mongo-to-postgres.dbml`/`.schema.sql` (the existing
rehearsal tooling) is a mechanical, table-per-Mongo-collection dump — every
embedded array/object was serialized to `jsonb` verbatim, including
ObjectIds that never got remapped to the new integer ids. It proved the
Mongo→Postgres pipeline mechanics work, but it is explicitly not a
production target (its own header says so).

Decision made: normalize **before** the real migration, as the target of a
single direct Mongo→normalized-Postgres ETL — not "dump raw, normalize
later." Full reasoning in the design doc; short version: the un-remapped
ObjectIds are only cleanly fixable while the Mongo documents and the
old→new id map still exist mid-transform, and normalizing twice (raw, then
again in Postgres) means writing the transform and cutting the app over
twice instead of once.

## Completed

- [x] **Denormalization audit** — compared the rehearsal DBML/schema.sql
      against the real Mongoose models (`lib/models.ts`) and
      `docs/VOCABULARY.md`. Catalogued every `jsonb` dump column, the
      un-remapped-ObjectId bug in `pickupHistory`, the `legacy_brand_id`
      self-ref ordering bug, and the `campaigns`/`deals` domain conflation.
- [x] **Normalized target schema drafted** — `docs/postgres-schema-proposal.dbml`.
      Structural normalization only; no speculative type changes or
      future-proofing. Key decompositions:
      - `users.referrals[]` → `user_referrals`
      - `users.pickupHistory[]` (+ nested `qrCodesWithWeights[]`,
        `addressSnapshot`) → `pickups` / `pickup_items` — this is what
        actually fixes the un-remapped-ObjectId bug, since the ETL is now
        forced to resolve `collectionId`/`captain` to real FKs
      - `users.location` / `structuredAddress` / `locationVerification`
        (~20 columns, optional, always written/read together) → split into
        its own 1:1 `user_locations` table rather than flattened onto
        `users`, so "no row" cleanly means "hasn't set location yet"
      - `users.passwordReset` + `users.emailVerification` (identical shape,
        two purposes) → merged into one `user_otp_flows` table
        discriminated by a `purpose` enum, instead of two duplicate column
        groups
      - `brands.environmentalStats` + `environmentalPeriods` →
        `brand_environmental_stats` (+ `brand_environmental_material_breakdown`)
      - `campaigns.discountCodes[]` / `addresses[]` → `campaign_discount_codes`
        / `campaign_addresses`
      - `deals.codes[]` → `deal_codes`, with `deal_claims.code` now a
        composite FK into it (a claim can't reference a code that was never
        issued); `promo_code` dropped as a stored duplicate of `codes[0]`
      - `organizations.moduleSubscriptions[]` → `organization_module_subscriptions`
      - `brandusers.moduleAccess[]` (module + permissions[]) → flattened to
        one `brand_user_module_access` table
      - `locations.cities[]` (nested towns) → real `cities` / `towns` tables
      - `brands.legacy_brand_id` self-ref: schema note documents the
        two-pass insert (NULL first, then `UPDATE` through the id map) the
        ETL must do to remove the Mongo-cursor-order dependency
- [x] **Static schema validation** — `docs/postgres-schema-proposal.dbml`
      parses cleanly with `dbml2sql` and generates valid Postgres DDL
      (`scripts/postgres-normalized-schema.sql`). Caught one real bug along
      the way: an apostrophe in a `Note` string broke the DBML parser.
- [x] **Live DDL verification** — the generated DDL applied with zero errors
      to a real Postgres 16 instance (throwaway Docker container): 30
      tables, 33 foreign keys, all enums, the composite PK on
      `user_otp_flows(user_id, purpose)`, and the composite FK
      `deal_claims(deal_id, code) → deal_codes(deal_id, code)` all created
      successfully.
- [x] **ETL script built** — `scripts/migrate-mongo-to-postgres-normalized.mjs`.
      Hand-rolled against the raw `mongodb`/`pg` drivers (the vendored
      declarative migration tool can't express these decompositions — no
      multi-target id remapping, no flattening nested objects, no merging
      two source sub-schemas into one discriminated table). Same safety
      guards as the existing rehearsal script: hard-locked to URIs with
      "test" in the db name, requires `--yes`, not idempotent, logs
      anything it can't migrate cleanly as a warning instead of aborting.
- [x] **Functional rehearsal against synthetic data** — seeded throwaway
      Mongo + Postgres containers with data covering every decomposed shape,
      including two deliberately broken edge cases (a pickup referencing a
      nonexistent captain; a deal claim for a code that was never issued).
      Found and fixed two real bugs in the process:
      1. The ETL's insert helper wrote explicit `NULL` for fields absent in
         Mongo, which defeats a column's `NOT NULL DEFAULT '...'` (a
         default only fires when the column is *omitted* from the INSERT,
         not when NULL is passed explicitly). Fixed.
      2. The DBML's one-to-one ref (`user_locations.user_id - users.id`)
         compiled to a backwards FK (`users.id → user_locations.user_id`),
         which would have required every user to have a location row
         before the user row could even be inserted. Fixed by using `>`
         like every other ref in the file — the PK on
         `user_locations.user_id` alone already enforces 1:1.
      After both fixes: full run succeeded, every row count reconciled
      against the seed data, a full reconstruction of one seeded pickup
      (joining `pickups` + `pickup_items` back together) matched the source
      Mongo document exactly, the two-pass `legacy_brand_id` resolution
      worked for the valid case, and both broken edge cases were caught and
      logged as warnings rather than corrupting data or crashing the run.

- [x] **Pre-flight structural-shape audit against real data** —
      `scripts/audit-mongo-shape.mjs` (new, read-only). Checks every
      array/sub-document field the ETL reads against its actual runtime
      type across all documents in the real `MONGODB_URI_TEST` cluster,
      including nested per-entry shapes (`pickupHistory[].qrCodesWithWeights`,
      `moduleAccess[].permissions`, `materialBreakdown[]`,
      `deals.claims[].{user,code}`). Result against the real test cluster:
      **zero shape anomalies** at any depth. Ran anyway as defense-in-depth:
      hardened the ETL itself (`asArray`/`asObject` helpers) so a
      present-but-wrong-type field is logged as a warning and treated as
      empty/absent, instead of silently corrupting rows (a string is
      iterable char-by-char in JS) or throwing and aborting the whole run.
      Also surfaced, as a non-anomaly finding: the real cluster has
      `discounts`, `emailSuppressions`, `geocodeCache`, `rateLimits`
      collections with no target table — checked, none are backed by a
      current Mongoose model (`discounts` in particular has 0 documents and
      no `Discount` schema in `lib/models.ts`) — confirmed out of scope, not
      an oversight.
- [x] **Ran the ETL against real data** (Homebrew-local Postgres 16, not
      Docker — `createdb mint_rewards_migration_test`, `psql -f
      scripts/postgres-normalized-schema.sql`). First run failed immediately:
      `null value in column "latitude" of relation "users" violates
      not-null constraint`. Root cause: a real document had `latitude`/
      `longitude` explicitly `null` (Mongoose's own default is `""` via
      `stringDefaultEmpty` — this record was written by something that
      bypassed it), and the ETL's insert helper only substituted a column's
      `DEFAULT` when a field was *absent* (`undefined`), not when it was
      explicitly `null`. Fixed generically in `presentEntries`: omit `null`
      the same as `undefined` (verified every `NOT NULL DEFAULT` column in
      the schema pairs a default with NOT NULL — no nullable column has a
      DEFAULT — so this doesn't change outcomes for genuinely nullable
      columns). Second run succeeded, exit 0.
- [x] **Data-integrity assertions against the real load** — every child-table
      row count reconciled exactly against source Mongo array-length sums
      (accounting for the `ON CONFLICT DO NOTHING` unique-dedup on
      `campaign_discount_codes`/`deal_codes`/`brand_user_module_access`, and
      for rows skipped due to orphaned refs — see below): 19 tables checked,
      all exact matches. A sample campaign's `addresses[]` reconstructed
      from `campaign_addresses` matched the source Mongo document
      field-for-field. `legacy_brand_id`'s two-pass resolution wasn't
      exercised — 0 brands in this test cluster have `legacyBrandId` set.
      `pickups`/`pickup_items`/`collections`/`collection_users`/
      `collection_captains` also weren't exercised — `pickupHistory` is
      empty on all 90 users and the `collections`/`captains`/`logistics`/
      `brandthemes` collections have 0 documents in this test cluster, so
      that part of the schema still only has synthetic-data coverage (see
      Remaining work).
      107 real warnings were logged (not errors): 16 campaigns + 13 deals
      reference a `brand` ObjectId that no longer resolves (brand since
      deleted from the test cluster), and 78 `campaigns.users[]` entries
      reference a deleted user — all correctly skipped rather than
      corrupting a row or crashing the run. Read as test-cluster churn
      (repeated create/delete during testing), not an ETL defect.

## Explicitly deferred — needs a decision, not just code

These were identified during the audit but deliberately **not** folded into
the schema draft:

- **`campaigns` vs. `deals`/Discount conflation.** Per `docs/VOCABULARY.md`,
  `campaigns` is already Discount-shaped data (discount codes, addresses,
  redeeming users) wearing a recycling-programme name. The draft normalizes
  its `jsonb` structurally but does not move that data onto `deals`. This is
  a domain/product decision — likely touches app routes, not just storage —
  and needs explicit owner sign-off before the real migration.
- **No `deal_type` discriminator added.** VOCABULARY.md notes every deal is
  implicitly a Discount today. Not adding a discriminator without a
  concrete second type to design against — would be designing for a
  hypothetical.
- **Location registry still keyed by display name, not id.**
  `users.structured_address.cityId`/`areaId` intentionally still match the
  name-keyed registry (`cities`/`towns` now have synthetic ids, but nothing
  reads through them via FK yet) — rewiring that would break a documented
  existing invariant ("the registry has no synthetic ids — its keys ARE the
  display names") and is an app-wide change beyond this migration's scope.
- **Type debt inherited from Mongoose** — `latitude`/`longitude`,
  `total_collections`, `total_waste_collected` as `text`; dates as `text`
  throughout `campaigns`/`deals`/`collections`. Not retyped without a data
  audit first — some are intentionally string-typed mid an in-progress
  dual-write (`latitude`/`longitude`), and blindly coercing types during
  migration risks data loss on unparseable rows.

## Remaining work

- [ ] **Real coverage for `pickups`/`pickup_items`/`collections` join
      tables.** The real test cluster has empty `pickupHistory` on every
      user and 0 documents in `collections`/`captains`/`logistics`/
      `brandthemes` — the decomposition that fixes the un-remapped-ObjectId
      bug (the main point of this schema) has only been run against
      synthetic data so far. Get a real or realistic-synthetic dataset with
      populated `pickupHistory` through the ETL before treating that part
      of the schema as real-data-verified.
- [ ] **Query parity against the actual app.** Inventory every Mongoose
      query in the route handlers touching `users`/`brands`/`campaigns`/
      `deals`/`organizations`/`brandusers`, write the equivalent SQL for
      each, and confirm identical results against the loaded test data.
      Since the mobile app only talks to this backend's HTTP API, the real
      acceptance test is diffing actual API responses (same account, same
      request) between the current Mongoose-backed backend and one rewritten
      against this schema. Not started.
- [ ] **Performance sanity.** `EXPLAIN ANALYZE` on the query patterns that
      had Mongo indexes backing them (the `referrals` `$in` lookup,
      deal-code lookups) to confirm the new indexes are actually used at
      realistic row counts. Not started.
- [ ] **Resolve the deferred domain decisions above** — specifically the
      `campaigns`/`deals` conflation — before or during the real migration,
      not after.
- [ ] **Choose production Postgres tooling.** No ORM/migration-tool decision
      has been made for production use — `pg`/`knex` are devDependencies
      used only by the rehearsal scripts; the live app is still 100%
      Mongoose. Needed before an actual cutover, not before the schema
      design work above.
- [ ] **Production cutover plan/timeline** — not yet defined anywhere in the
      repo; out of scope for this doc.

## File manifest

| File | Status | Purpose |
|---|---|---|
| `scripts/migrate-mongo-to-postgres.dbml` / `.schema.sql` / `.mjs` | pre-existing, unchanged | Raw rehearsal dump — proved pipeline mechanics, not a production target |
| `docs/postgres-schema-proposal.dbml` | new | Normalized target schema (source of truth for schema design) |
| `scripts/postgres-normalized-schema.sql` | new, generated | DDL generated from the DBML above — regenerate via the command in its header, do not hand-edit |
| `scripts/migrate-mongo-to-postgres-normalized.mjs` | new | ETL from Mongo into the normalized schema — verified against synthetic data AND a real test-cluster run (2026-09-02, local Homebrew Postgres) |
| `scripts/audit-mongo-shape.mjs` | new | Read-only pre-flight check: real Mongo data's array/sub-document fields against the ETL's shape assumptions |
