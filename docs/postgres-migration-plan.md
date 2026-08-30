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

- [ ] **Run the ETL against real data.** Blocked: `MONGODB_URI_TEST` is
      empty and `POSTGRES_URL_TEST` is unset in `.env`. Once configured,
      run `scripts/migrate-mongo-to-postgres-normalized.mjs --yes` against
      the real `mint_rewards_test` snapshot (or an anonymized copy) into a
      scratch Postgres. This is where real-data failure modes the synthetic
      rehearsal can't produce are expected to surface: unexpected enum
      values written by a direct-DB script that bypassed Mongoose
      validation, genuinely duplicate codes/modules that would violate the
      new `UNIQUE` constraints, and real orphaned `pickupHistory` refs.
- [ ] **Data-integrity assertions against that real load** — same pattern
      already proven on synthetic data: child-table row counts vs. source
      array-length sums, and reconstructing a sample of `pickups` +
      `pickup_items` back into the original nested shape to diff against
      the source documents field-for-field.
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
| `scripts/migrate-mongo-to-postgres-normalized.mjs` | new | ETL from Mongo into the normalized schema — verified against synthetic data, not yet run against real data |
