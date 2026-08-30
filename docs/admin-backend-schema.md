# Admin backend schema: design and open decisions

Schema for the new admin backend that manages collection captains,
collections (recycling pickup runs), household/user assignment, and pickup
execution — driven by mockups of the admin dashboard, the "Add New Captain"
form, and the "Approved Captains" list. Companion to
`docs/admin-backend-schema.dbml` (the schema itself). Domain terms
("Collection" as a recycling programme container vs. "Deal"/"Campaign") are
per `docs/VOCABULARY.md` — note the Collection modeled here is the pickup
*run* entity (`CollectionModel` in `lib/models.ts`), unrelated to Campaign.

## Why this is a separate database, not an extension of the Mongo models

Mint-Rewards-Backend already has live Mongoose models for exactly this
domain — `CaptainSchema`, `CollectionSchema`, `User.pickupHistory` — and a
drafted normalized Postgres target for them in
`docs/postgres-schema-proposal.dbml` (`captains`, `collections`,
`collection_users`, `collection_captains`, `pickups`, `pickup_items`).

This schema is deliberately a **new, separate database for a new admin
service**, and is meant to **become the source of truth** for captains,
collections, and pickups going forward — not a read replica, and not
scoped to admin-only bookkeeping layered on top of the existing Mongo data.
Practically that means:

- `docs/postgres-schema-proposal.dbml`'s `captains`/`collections`/`pickups`/
  `pickup_items` tables are superseded by this schema for those entities.
  That proposal still stands for everything else it covers (users, brands,
  campaigns, deals, organizations) — this document does not touch those.
- Consumer **Users stay exactly where they are** (Mint-Rewards-Backend's
  Mongo `users` collection). The admin's "Users" screen and "User History"
  are a view over that existing data, not a new entity. This schema
  references a user only by their existing Mongo ObjectId, stored as opaque
  `text` (`collection_users.user_id`, `pickups.user_id`) — **not a foreign
  key**, since referential integrity can't be enforced across two separate
  databases. If a user is deleted or has its id changed on the Mongo side,
  nothing here will catch that automatically.

## Key decisions made during design

1. **Postgres**, reusing the conventions of the existing
   `postgres-schema-proposal.dbml` (same enum/table/Note/index style) rather
   than inventing a new format.
2. **Captains self-register and admins approve/reject.** `captain_status`
   (`PENDING` → `APPROVED`/`REJECTED`, plus `SUSPENDED`, `REMOVED`) replaces
   the current schema's total absence of a status field. `approved_by` /
   `approved_at` / `rejected_reason` capture who acted and why.
3. **Deleting a captain is a soft delete** (`status = REMOVED`), not a row
   delete. The mockup's trash icon can't mean a hard delete: `collections.
   captain_id` and `pickups.captain_id` must keep resolving for historical
   collections/pickups a since-removed captain actually ran.
4. **One captain per collection**, a plain `collections.captain_id` FK —
   not the old `captainsWithDates[]` many-to-many-with-date pattern. Matches
   the dashboard mockup's single "Captain" column per collection row.
   Reassigning a captain is a single-column update.
5. **Collection status is derived, not admin-set.** `UPCOMING` →
   `IN_PROGRESS` fires automatically off the first `pickups` row recorded
   against the collection. `CANCELLED` is the one status an admin sets
   directly, valid from any pre-`COMPLETED` state.
6. **RBAC via `admin_roles` / `admin_permissions` / `admin_role_permissions`**,
   not a flat role enum — you need multiple roles *and* multiple permission
   levels, so what a role can do should be data an admin can edit, not a
   hardcoded mapping in application code.
7. **`admin_audit_log`** exists to serve "monitoring" as a stated
   responsibility of this admin backend — every approve/reject/remove/cancel
   action gets a row (`admin_id`, `action`, `entity_type`, `entity_id`,
   `metadata`).
8. `radius` / `start_area_lat` / `start_area_lng` are `numeric` here, not the
   `text` they are in the current Mongoose `CollectionSchema` — fixing that
   type debt now since this is a fresh table, not an ETL target constrained
   to match legacy shapes.

## Flagged for explicit confirmation — not yet locked in

- **`COMPLETED` trigger.** The draft says a collection auto-completes when a
  `pickups` row exists for every `collection_users` row (every assigned
  household visited). This was proposed but never explicitly confirmed — an
  alternative is treating completion as an explicit captain/admin action,
  since a route can reasonably end with some no-shows that never get a
  `pickups` row, which would otherwise leave the collection stuck at
  `IN_PROGRESS` forever. **Needs a decision before this schema is built
  against.**
- **`pickups.status` stayed a free-text field**, matching the current
  Mongoose `pickupHistorySchema.status` (`stringRequired`, no enum). No new
  enum values were invented for it since none were specified — if the admin
  dashboard needs to filter/aggregate by pickup outcome (e.g. completed vs.
  missed vs. partial), that should become a real enum, not stay free text.
- **No data backfill/ETL plan.** This is a schema for a new database, not a
  migration script. Two backfill questions are unresolved:
  - Do existing captains in Mongo's `captains` collection get carried over
    (and if so, as `APPROVED`, since they were presumably already vetted
    under the old no-status system), or does this launch with an empty
    `captains` table and everyone re-registers?
  - Do existing `collections` / `User.pickupHistory` documents get
    backfilled into `collections` / `pickups` / `pickup_items`, or does
    history before cutover stay in Mongo (queried separately) while this
    database starts from zero going forward?
- **Auth/session model for the admin login and captain self-registration**
  (JWT vs. session cookies, token expiry, password reset flow) isn't
  specified in this schema — `admins.password_hash` and `captains.
  password_hash` assume whatever hashing/session scheme the admin service
  ends up using, but that service's actual auth implementation is out of
  scope here.
- **Cross-database consistency at write time** is inherently best-effort:
  when the admin service records `collection_users.user_id` or `pickups.
  user_id`, there is no transaction spanning this Postgres database and
  Mint-Rewards-Backend's Mongo. A user id typo, or a user deleted on the
  Mongo side after being assigned here, will not be caught by any
  constraint in this schema.

## File manifest

| File | Purpose |
|---|---|
| `docs/admin-backend-schema.dbml` | The schema itself — paste into https://dbdiagram.io to render |
| `docs/admin-backend-schema.md` | This document |
| `docs/postgres-schema-proposal.dbml` | Unchanged. Still authoritative for users/brands/campaigns/deals/organizations; its `captains`/`collections`/`pickups`/`pickup_items` tables are superseded by this schema |
| `docs/VOCABULARY.md` | Unchanged. Domain term definitions this document defers to |
