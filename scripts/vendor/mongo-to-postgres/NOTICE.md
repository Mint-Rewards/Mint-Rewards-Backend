# Vendored: mongo-to-postgres

Source: https://github.com/alxnkt/mongo-to-postgres (npm `mongo-to-postgres`,
version 0.0.6), MIT licensed, © alxnkt.

Vendored here (instead of depended on via npm) and patched in two places:

1. **`src/put-to-postgres.js`** — upstream silently `delete`s any array
   field that isn't declared in a collection's `links` config before
   inserting a row. That loses data (e.g. `users.pickupHistory`,
   `users.referrals`, `organizations.moduleSubscriptions` in this project's
   schema) with no way to opt out via the public config. This copy
   `JSON.stringify`s those arrays instead of deleting them, so they land as
   JSON in a `jsonb` (or `text`) column. `links`-managed arrays are still
   handled exactly as before (deleted from the row, inserted into the join
   table).
   - Caveat: any Mongo ObjectId referenced *inside* one of these
     JSON-serialized arrays (e.g. `pickupHistory[].collectionId`) stays as
     the original Mongo id — it is not remapped to the new Postgres integer
     id the way a top-level `foreignKeys`/`links` field is. Don't join on
     those values against the new tables without a separate remap step.
2. **`index.js`** — fixed `console.err` (not a function) to `console.error`
   in the top-level connection error handlers, which otherwise threw and
   masked the real Mongo/Postgres connection failure.

No other behavior was changed. See `scripts/migrate-mongo-to-postgres.mjs`
for how this is used, and `scripts/migrate-mongo-to-postgres.schema.sql` for
which columns are `jsonb` because of the first patch.
