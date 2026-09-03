#!/usr/bin/env node
// Verifies a normalized-ETL run that was fed by scripts/seed-etl-pickup-fixtures.mjs.
//
// Counts alone do not prove a decomposition is correct — a row can exist with
// the wrong FK, swapped coordinates or a dropped field and still count. These
// assertions reconstruct the decomposed data and diff it against the Mongo
// source, and they cover the branches that ONLY the fixtures reach:
// pickups/pickup_items, the collection join tables, cities/towns, and the
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

// 3. full reconstruction of the happy-path pickup vs the Mongo source
const srcUser = await db
  .collection("users")
  .findOne({ userName: "ETL Fixture User Pickups" });
const src = srcUser.pickupHistory[0];
const p = (
  await pgc.query(
    `select pk.*, c.name collection_name, cap.name captain_name
   from pickups pk join collections c on c.id=pk.collection_id
   join captains cap on cap.id=pk.captain_id
   where pk.comment=$1`,
    [src.comment],
  )
).rows[0];
const items = (
  await pgc.query(
    `select qr_code, weight from pickup_items where pickup_id=$1 order by id`,
    [p.id],
  )
).rows;
check(
  "happy-path pickup: collection FK remapped to the right row",
  p.collection_name === src.collectionName,
);
check(
  "happy-path pickup: captain FK remapped",
  p.captain_name === "ETL Fixture Captain One",
);
check(
  "happy-path pickup: status/date preserved",
  p.status === src.status &&
    new Date(p.occurred_at).getTime() === src.date.getTime(),
);
const srcItems = src.qrCodesWithWeights.map((q) => ({
  qr_code: q.qrCode,
  weight: String(q.weight),
}));
check(
  "pickup_items reconstruct exactly (order, codes, weights)",
  JSON.stringify(
    items.map((i) => ({
      qr_code: i.qr_code,
      weight: String(Number(i.weight)),
    })),
  ) ===
    JSON.stringify(
      srcItems.map((i) => ({
        qr_code: i.qr_code,
        weight: String(Number(i.weight)),
      })),
    ),
  JSON.stringify(items),
);
const s = src.addressSnapshot;
check(
  "addressSnapshot flattened field-for-field",
  p.snapshot_address === s.address &&
    p.snapshot_city === s.city &&
    p.snapshot_town === s.town &&
    p.snapshot_structured_city_id === s.structuredAddress.cityId &&
    p.snapshot_structured_block_id === s.structuredAddress.blockId &&
    p.snapshot_house_no === s.structuredAddress.houseNo,
);
check(
  "GeoJSON [lng,lat] split into the correct columns (not swapped)",
  Number(p.snapshot_location_lng) === s.location.coordinates[0] &&
    Number(p.snapshot_location_lat) === s.location.coordinates[1],
  `lng=${p.snapshot_location_lng} lat=${p.snapshot_location_lat} src=${JSON.stringify(s.location.coordinates)}`,
);
check(
  "location enums preserved",
  p.snapshot_location_source === s.location.source &&
    p.snapshot_location_precision === s.location.precision,
);
check("snapshot_source enum preserved", p.snapshot_source === s.snapshotSource);

// 4. pre-P0.4a pickup: snapshot absent entirely
const p2 = (
  await pgc.query(
    `select * from pickups where comment='No addressSnapshot — pre-P0.4a shape.'`,
  )
).rows[0];
check("pre-P0.4a pickup migrated (parent row exists)", !!p2);
// The snapshot_* columns are deliberately NULLABLE with no default (unlike
// e.g. `comment`, which is NOT NULL DEFAULT ''). That is the correct design:
// NULL distinguishes "this pickup predates address snapshots" from "a snapshot
// was taken and the field was empty". Asserting '' here would be asserting the
// wrong semantics.
check(
  "absent addressSnapshot -> every snapshot column NULL, run not aborted",
  p2.snapshot_address === null &&
    p2.snapshot_city === null &&
    p2.snapshot_location_lat === null &&
    p2.snapshot_source === null,
  `address=${JSON.stringify(p2.snapshot_address)} lat=${p2.snapshot_location_lat} source=${p2.snapshot_source}`,
);

// 5. snapshot with location but no coordinates
const p3 = (
  await pgc.query(
    `select * from pickups where comment='Snapshot without coordinates, zero items.'`,
  )
).rows[0];
check(
  "coordinate-less snapshot: lng/lat NULL but enums still set",
  p3.snapshot_location_lng === null &&
    p3.snapshot_location_lat === null &&
    p3.snapshot_location_source === "area_centroid" &&
    p3.snapshot_location_precision === "area",
);
check(
  "pickup with zero items still produced its parent row",
  Number(
    (
      await pgc.query(
        `select count(*) c from pickup_items where pickup_id=$1`,
        [p3.id],
      )
    ).rows[0].c,
  ) === 0,
);

// 6. skipped pickups left NO partial rows
const skipped = await pgc.query(
  `select count(*) c from pickups where comment like '%points at a deleted%'`,
);
check(
  "both dangling-ref pickups skipped cleanly (no half rows)",
  Number(skipped.rows[0].c) === 0,
);
const orphanItems = await pgc.query(
  `select count(*) c from pickup_items where qr_code like 'ETLFIX-QR-SKIP-%'`,
);
check(
  "skipped pickups' items not orphaned into pickup_items",
  Number(orphanItems.rows[0].c) === 0,
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

// 8. collection children
const cu = await pgc.query(
  `select u.user_name from collection_users cu join users u on u.id=cu.user_id join collections c on c.id=cu.collection_id where c.name like '%full%' order by u.user_name`,
);
check(
  "collection_users resolved to the right users",
  JSON.stringify(cu.rows.map((r) => r.user_name)) ===
    JSON.stringify(["ETL Fixture User Pickups", "ETL Fixture User Second"]),
);
const cc = await pgc.query(
  `select cap.name, cc.date from collection_captains cc join captains cap on cap.id=cc.captain_id order by cap.name`,
);
check(
  "collection_captains resolved with dates",
  cc.rows.length === 2 && cc.rows.every((r) => !!r.date),
);

console.log(`\n${pass} passed, ${fail} failed`);
await mongo.close();
await pgc.end();
process.exit(fail ? 1 : 0);
