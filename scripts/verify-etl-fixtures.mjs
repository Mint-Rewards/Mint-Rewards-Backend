#!/usr/bin/env node
// Verifies a normalized-ETL run that was fed by scripts/seed-etl-pickup-fixtures.mjs.
//
// Trimmed 2026-09-06: the pickup and collection-join assertions went with the
// tables themselves — captains, collections and pickups are the admin service's
// now (mint-rewards-admin-api/docs/schema-reconciliation.md). What remains is
// the coverage that was never about them: the legacy_brand_id two-pass, the
// explicit-null lat/lng regression lock, and locations -> cities -> towns.
// The seeder still writes the pickup shapes; the ETL simply no longer reads
// pickupHistory, so they are inert rather than wrong.
//
// Counts alone do not prove a decomposition is correct — a row can exist with
// the wrong FK, swapped coordinates or a dropped field and still count. These
// assertions reconstruct the decomposed data and diff it against the Mongo
// source, and they cover the branches that ONLY the fixtures reach:
// cities/towns, the legacy_brand_id two-pass, and the
// legacy_brand_id two-pass resolution.
//
// Run AFTER:
//   ETL_FIXTURES_MONGODB_URI=<fixture db> node scripts/seed-etl-pickup-fixtures.mjs --yes
//   psql "$PG" -f scripts/postgres-normalized-schema.sql      # empty database
//   MONGODB_URI_TEST=<fixture db> POSTGRES_URL_TEST="$PG" \
//     node scripts/migrate-mongo-to-postgres-normalized.mjs --yes
//
// Then:
//   MONGODB_URI_TEST=<fixture db> POSTGRES_URL_TEST="$PG" \
//     node scripts/verify-etl-fixtures.mjs
//
// Exits non-zero if any assertion fails, so it can gate CI.

import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import pg from "pg";
dotenv.config({ path: ".env" });
const mongo = new MongoClient(process.env.MONGODB_URI_TEST);
await mongo.connect();
const db = mongo.db();
const pgc = new pg.Client({ connectionString: process.env.POSTGRES_URL_TEST });
await pgc.connect();
let pass = 0,
  fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`,
  );
};

// 1. legacy_brand_id two-pass: child must point at parent, dangling must be NULL
const b = await pgc.query(
  `select brand_name, id, legacy_brand_id from brands order by id`,
);
const byName = Object.fromEntries(b.rows.map((r) => [r.brand_name, r]));
check(
  "legacy_brand_id two-pass resolved forward reference",
  byName["ETL Fixture Brand Legacy-Child"].legacy_brand_id ===
    byName["ETL Fixture Brand Legacy-Parent"].id,
  `child.legacy_brand_id=${byName["ETL Fixture Brand Legacy-Child"].legacy_brand_id} parent.id=${byName["ETL Fixture Brand Legacy-Parent"].id}`,
);
check(
  "dangling legacyBrandId left NULL, run not aborted",
  byName["ETL Fixture Brand Legacy-Dangling"].legacy_brand_id === null,
);

// 2. explicit-null lat/long must land as '' via column DEFAULT (regression lock)
const u = await pgc.query(
  `select user_name, latitude, longitude from users where user_name='ETL Fixture User NullCoords'`,
);
check(
  "explicit null latitude/longitude fell back to NOT NULL DEFAULT ''",
  u.rows[0].latitude === "" && u.rows[0].longitude === "",
  `latitude=${JSON.stringify(u.rows[0].latitude)} longitude=${JSON.stringify(u.rows[0].longitude)}`,
);

// 7. cities/towns nesting
const towns = await pgc.query(
  `select c.name city, t.name town from towns t join cities c on c.id=t.city_id order by c.name, t.name`,
);
const srcLoc = await db
  .collection("locations")
  .findOne({ province: "ETL Fixture Province" });
const expected = srcLoc.cities
  .flatMap((c) => c.towns.map((t) => ({ city: c.name, town: t })))
  .sort((a, b) => a.city.localeCompare(b.city) || a.town.localeCompare(b.town));
check(
  "locations -> cities -> towns nesting preserved",
  JSON.stringify(towns.rows) === JSON.stringify(expected),
  JSON.stringify(towns.rows),
);


console.log(`\n${pass} passed, ${fail} failed`);
await mongo.close();
await pgc.end();
process.exit(fail ? 1 : 0);
