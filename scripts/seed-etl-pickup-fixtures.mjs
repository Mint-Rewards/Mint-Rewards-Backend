#!/usr/bin/env node
// Seeds the Mongo-side fixtures the normalized ETL
// (scripts/migrate-mongo-to-postgres-normalized.mjs) has never been able to
// exercise against real data, because NOTHING IN EITHER REPO WRITES THEM.
//
// `pickupHistory` appears in lib/models.ts, lib/types.ts, lib/pickupSnapshot.ts,
// the migration scripts and the tests — and in zero route handlers. There is no
// pickup writer yet (see docs/plans/HANDOFF-2026-08-25.md: "every future pickup
// writer must call buildPickupAddressSnapshot; no pickup writer exists in any
// repo yet"). So the real test cluster will never accumulate this data on its
// own, and `pickups` / `pickup_items` / `collections` / `collection_users` /
// `collection_captains` / `cities` / `towns` all load 0 rows from it. Same for
// the `legacy_brand_id` two-pass resolution: 0 brands have `legacyBrandId` set.
//
// This script closes that gap deliberately rather than waiting for data that
// isn't coming.
//
// WHY THE RAW DRIVER, NOT MONGOOSE (unlike scripts/seed-brandhub-*.js):
// several fixtures below are defined by what Mongoose would *not* let them be.
// `PRE_SNAPSHOT` needs `addressSnapshot` genuinely ABSENT, and `NULL_COORDS`
// needs `latitude`/`longitude` explicitly `null` — which is precisely the
// real-world shape that broke the ETL's first real-data run (a document
// written by a script that bypassed Mongoose's `stringDefaultEmpty`). Applying
// Mongoose defaults here would coerce both fixtures into uselessness.
//
// Usage:
//   node scripts/seed-etl-pickup-fixtures.mjs            # dry run, prints plan
//   node scripts/seed-etl-pickup-fixtures.mjs --yes      # seed
//   node scripts/seed-etl-pickup-fixtures.mjs --drop     # remove, don't recreate
//
// Idempotent: every document has a deterministic _id under a reserved prefix
// (see FIXTURE_PREFIX), so a re-run deletes exactly its own documents and
// recreates them. It never touches a document it did not create.
//
// TARGET: MONGODB_URI_TEST by default, or ETL_FIXTURES_MONGODB_URI to point at
// a dedicated database. Prefer the latter — the shared test cluster churns
// under other work (its user count moved 90 -> 42 between two ETL runs on the
// same day), and a dedicated db keeps the reconciliation counts below exact
// rather than "exact, plus whatever else happens to be in there".

import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const URI =
  process.env.ETL_FIXTURES_MONGODB_URI || process.env.MONGODB_URI_TEST;
const URI_SOURCE = process.env.ETL_FIXTURES_MONGODB_URI
  ? "ETL_FIXTURES_MONGODB_URI"
  : "MONGODB_URI_TEST";

if (!URI) {
  console.error(
    "Neither ETL_FIXTURES_MONGODB_URI nor MONGODB_URI_TEST is set — " +
      "define one in .env (see .env.example).",
  );
  process.exit(1);
}

// Same guard as seed-brandhub-demo.js and the ETL itself: the database NAME
// must clearly be a test database, never the production mint_rewards DB.
const dbNameFromUri = (uri) => {
  const m = uri.match(/\/([^/?]+)(\?|$)/);
  return m ? m[1] : "";
};
const DB_NAME = dbNameFromUri(URI);
if (!/(^|[-_])test([-_]|$)|^test_db$/i.test(DB_NAME)) {
  console.error(
    `Refusing to run: ${URI_SOURCE} points at database "${DB_NAME}", which does ` +
      `not look like a test database. This script only runs against an ` +
      `isolated test database.`,
  );
  process.exit(1);
}

const redact = (uri) => uri.replace(/\/\/[^@]+@/, "//<redacted>@");

// ---------------------------------------------------------------------------
// Deterministic ids. Every fixture _id is "e7f" + a zero-padded ordinal, so the
// whole fixture set is addressable as a single _id range and --drop can remove
// exactly it. "e7f" is not a prefix any real ObjectId timestamp produces in
// this era (it would place the document ~year 2093), so a collision with real
// data is not a practical concern.
const FIXTURE_PREFIX = "e7f";
let nextOrdinal = 1;
const fid = () =>
  new ObjectId(FIXTURE_PREFIX + String(nextOrdinal++).padStart(21, "0"));

// A separate, non-fixture id used for the deliberately-dangling references.
// Nothing is ever inserted at these ids — that is the point.
const DANGLING = {
  collection: new ObjectId("dead0000000000000000c001"),
  captain: new ObjectId("dead0000000000000000ca01"),
  user: new ObjectId("dead0000000000000000f001"),
  brand: new ObjectId("dead0000000000000000b001"),
};

// ---------------------------------------------------------------------------
// Ids allocated up front so cross-references are explicit and readable.
const ID = {
  captain1: fid(),
  captain2: fid(),
  logistics1: fid(),
  // legacyChild is allocated BEFORE legacyParent, so it sorts earlier and is
  // returned earlier in natural cursor order. That ordering is the whole point:
  // it is what makes the naive single-pass insert fail (the child's FK target
  // does not exist yet) and what the ETL's two-pass resolution exists to fix.
  brandLegacyChild: fid(),
  brandLegacyParent: fid(),
  brandLegacyDangling: fid(),
  brandTheme1: fid(),
  location1: fid(),
  userPickups: fid(),
  userSecond: fid(),
  userNoPickups: fid(),
  userNullCoords: fid(),
  collectionFull: fid(),
  collectionDangling: fid(),
};

const ALL_FIXTURE_IDS = Object.values(ID);

const now = new Date("2026-09-02T10:00:00.000Z");
const iso = (d) => d.toISOString();

// ---------------------------------------------------------------------------
// Fixture documents.

const captains = [
  {
    _id: ID.captain1,
    name: "ETL Fixture Captain One",
    phone: "+92 300 0000001",
    email: "etl-fixture-captain-1@example.test",
    password: "$2a$10$etlfixturehashnotarealpassword000000000000000000000",
    avatar: "",
    nationalId: "42101-0000001-1",
    role: "CAPTAIN",
    deviceToken: "",
    created: now,
    emailVerified: true,
  },
  {
    _id: ID.captain2,
    name: "ETL Fixture Captain Two",
    phone: "+92 300 0000002",
    email: "etl-fixture-captain-2@example.test",
    password: "$2a$10$etlfixturehashnotarealpassword000000000000000000000",
    avatar: "",
    role: "CAPTAIN",
    deviceToken: "",
    created: now,
    emailVerified: false,
  },
];

const logistics = [
  {
    _id: ID.logistics1,
    name: "ETL Fixture Logistics",
    phone: "+92 300 0000003",
    email: "etl-fixture-logistics@example.test",
    password: "$2a$10$etlfixturehashnotarealpassword000000000000000000000",
    avatar: "",
    role: "LOGISTIC",
    deviceToken: "",
    created: now,
    emailVerified: true,
  },
];

const brandBase = (n) => ({
  companyName: `ETL Fixture Brand ${n} Ltd`,
  brandName: `ETL Fixture Brand ${n}`,
  email: `etl-fixture-brand-${n}@example.test`,
  category: "Retail",
  webLink: "https://example.test",
  contactName: "Fixture Contact",
  phone: "+92 300 0000010",
  registrationNumber: `ETL-FIXTURE-REG-${n}`,
  domain: "example.test",
  themeColor: "#00A86B",
  status: "APPROVED",
  role: "BRAND",
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
});

const brands = [
  // Child references a parent that appears LATER in cursor order — exercises
  // the deferred-UPDATE second pass.
  {
    _id: ID.brandLegacyChild,
    ...brandBase("Legacy-Child"),
    legacyBrandId: ID.brandLegacyParent,
  },
  { _id: ID.brandLegacyParent, ...brandBase("Legacy-Parent") },
  // References a brand that does not exist — must warn and leave the column
  // NULL rather than abort the run.
  {
    _id: ID.brandLegacyDangling,
    ...brandBase("Legacy-Dangling"),
    legacyBrandId: DANGLING.brand,
  },
];

const brandthemes = [
  {
    _id: ID.brandTheme1,
    name: "ETL Fixture Theme",
    logo: "https://example.test/logo.png",
    backgroundColor: "#FFFFFF",
    accentColor: "#00A86B",
    status: "APPROVED",
  },
];

// locations -> cities -> towns. Two cities, five towns total.
const locations = [
  {
    _id: ID.location1,
    province: "ETL Fixture Province",
    cities: [
      { name: "Fixture City A", towns: ["Town A1", "Town A2", "Town A3"] },
      { name: "Fixture City B", towns: ["Town B1", "Town B2"] },
    ],
  },
];

// --- pickupHistory entries -------------------------------------------------
// Each one exists to drive a specific branch in the ETL's pickup block.

const fullSnapshot = {
  address: "House 1, Street 2",
  province: "Sindh",
  city: "Karachi",
  town: "Gulshan-e-Iqbal Block 8",
  townOther: "",
  subArea: "",
  subAreaOther: "",
  structuredAddress: {
    cityId: "Karachi",
    areaId: "Gulshan-e-Iqbal",
    blockId: "Block 8",
    areaOther: "",
    blockOther: "",
    houseNo: "1",
    streetOrBlock: "Street 2",
  },
  location: {
    type: "Point",
    coordinates: [67.0822, 24.9204], // [lng, lat] — GeoJSON order
    source: "map_pin",
    precision: "building",
    accuracyMeters: 12,
    capturedAt: now,
  },
  // snapshotSource is enum ["creation","migrated"] in lib/models.ts — the two
  // fixtures below cover both values.
  snapshotSource: "creation",
  snapshotAt: now,
};

// Snapshot present, but `location` carries no coordinates. Drives the
// `snapLoc.coordinates?.[0]` optional-chain — the column must land NULL, not
// throw and not silently write a wrong value.
const snapshotWithoutCoords = {
  address: "House 9",
  province: "Punjab",
  city: "Lahore",
  town: "Model Town Block B",
  townOther: "",
  subArea: "",
  subAreaOther: "",
  structuredAddress: {
    cityId: "Lahore",
    areaId: "Model Town",
    blockId: "Block B",
    houseNo: "9",
    streetOrBlock: "",
  },
  location: {
    type: "Point",
    source: "area_centroid",
    precision: "area",
  },
  snapshotSource: "migrated",
  snapshotAt: now,
};

const pickupsForUserOne = [
  {
    // 1. Happy path: both refs resolve, snapshot complete, items present.
    collectionId: ID.collectionFull,
    collectionName: "ETL Fixture Collection (full)",
    date: now,
    captain: ID.captain1,
    qrCodesWithWeights: [
      { qrCode: "ETLFIX-QR-0001", weight: 3.5 },
      { qrCode: "ETLFIX-QR-0002", weight: 1.25 },
      { qrCode: "ETLFIX-QR-0003", weight: 0 },
    ],
    status: "COMPLETED",
    comment: "Full snapshot, three items.",
    addressSnapshot: fullSnapshot,
  },
  {
    // 2. Pre-P0.4a entry: addressSnapshot genuinely ABSENT (not null, not {}).
    //    Every snapshot_* column must fall back to its schema default.
    collectionId: ID.collectionFull,
    collectionName: "ETL Fixture Collection (full)",
    date: now,
    captain: ID.captain2,
    qrCodesWithWeights: [{ qrCode: "ETLFIX-QR-0004", weight: 7.75 }],
    status: "COMPLETED",
    comment: "No addressSnapshot — pre-P0.4a shape.",
  },
  {
    // 3. Snapshot present, coordinates absent, and NO items at all — a pickup
    //    with zero pickup_items rows must still produce its parent row.
    collectionId: ID.collectionFull,
    collectionName: "ETL Fixture Collection (full)",
    date: now,
    captain: ID.captain1,
    qrCodesWithWeights: [],
    status: "PENDING",
    comment: "Snapshot without coordinates, zero items.",
    addressSnapshot: snapshotWithoutCoords,
  },
  {
    // 4. Dangling collectionId — THE un-remapped-ObjectId case. Must warn and
    //    skip the whole pickup, not write a half row.
    collectionId: DANGLING.collection,
    collectionName: "Deleted Collection",
    date: now,
    captain: ID.captain1,
    qrCodesWithWeights: [{ qrCode: "ETLFIX-QR-SKIP-1", weight: 1 }],
    status: "COMPLETED",
    comment: "collectionId points at a deleted collection.",
    addressSnapshot: fullSnapshot,
  },
  {
    // 5. Dangling captain — same skip path, other side of the `&&`.
    collectionId: ID.collectionFull,
    collectionName: "ETL Fixture Collection (full)",
    date: now,
    captain: DANGLING.captain,
    qrCodesWithWeights: [{ qrCode: "ETLFIX-QR-SKIP-2", weight: 2 }],
    status: "COMPLETED",
    comment: "captain points at a deleted captain.",
    addressSnapshot: fullSnapshot,
  },
];

const pickupsForUserTwo = [
  {
    // 6. A second user with pickups, so pickups are not all under one user_id
    //    and the per-user fan-out is actually exercised.
    collectionId: ID.collectionFull,
    collectionName: "ETL Fixture Collection (full)",
    date: now,
    captain: ID.captain2,
    qrCodesWithWeights: [
      { qrCode: "ETLFIX-QR-0005", weight: 4 },
      { qrCode: "ETLFIX-QR-0006", weight: 2.5 },
    ],
    status: "COMPLETED",
    comment: "Second user's pickup.",
    addressSnapshot: fullSnapshot,
  },
];

const userBase = (n) => ({
  userName: `ETL Fixture User ${n}`,
  email: `etl-fixture-user-${n}@example.test`,
  password: "$2a$10$etlfixturehashnotarealpassword000000000000000000000",
  avatar: "",
  address: "",
  province: "",
  city: "",
  town: "",
  townOther: "",
  subArea: "",
  subAreaOther: "",
  phone: "",
  mintId: `ETLFIX-${n}`,
  role: "MEMBER",
  latitude: "",
  longitude: "",
  deviceToken: "",
  points: 0,
  totalCollections: "",
  totalWasteCollected: "",
  referrals: [],
  referralRewardGranted: false,
  pickupHistory: [],
  created: now,
  firstTimeLogin: false,
});

const users = [
  {
    _id: ID.userPickups,
    ...userBase("Pickups"),
    pickupHistory: pickupsForUserOne,
  },
  {
    _id: ID.userSecond,
    ...userBase("Second"),
    pickupHistory: pickupsForUserTwo,
  },
  // Control: no pickupHistory at all. Confirms the deferred-pickup pass simply
  // skips users with nothing to contribute.
  { _id: ID.userNoPickups, ...userBase("NoPickups") },
  {
    // Regression lock for the bug that failed the ETL's FIRST real-data run:
    // latitude/longitude explicitly null (written by something that bypassed
    // Mongoose's stringDefaultEmpty) against a NOT NULL DEFAULT '' column.
    // `presentEntries` must omit null the same as undefined so the column
    // default fires. If that fix is ever regressed, this row fails the run.
    _id: ID.userNullCoords,
    ...userBase("NullCoords"),
    latitude: null,
    longitude: null,
  },
];

const collections = [
  {
    _id: ID.collectionFull,
    name: "ETL Fixture Collection (full)",
    area: "Gulshan-e-Iqbal",
    city: "Karachi",
    radius: "5",
    startAreaLat: "24.9204",
    startAreaLang: "67.0822",
    startDate: iso(now),
    status: "COMPLETED",
    users: [ID.userPickups, ID.userSecond],
    captainsWithDates: [
      { date: iso(now), captain: ID.captain1 },
      { date: iso(now), captain: ID.captain2 },
    ],
  },
  {
    // Both child arrays point at deleted documents — each must warn and skip
    // its row while the parent collection still migrates.
    _id: ID.collectionDangling,
    name: "ETL Fixture Collection (dangling refs)",
    area: "Clifton",
    city: "Karachi",
    radius: "3",
    startAreaLat: "24.8138",
    startAreaLang: "67.0300",
    startDate: iso(now),
    status: "PENDING",
    users: [DANGLING.user],
    captainsWithDates: [{ date: iso(now), captain: DANGLING.captain }],
  },
];

const PLAN = [
  ["captains", captains],
  ["logistics", logistics],
  ["brands", brands],
  ["brandthemes", brandthemes],
  ["locations", locations],
  ["users", users],
  ["collections", collections],
];

// ---------------------------------------------------------------------------
// Expected ETL output, derived from the fixtures above rather than hardcoded —
// so editing a fixture updates the expectation automatically and the two can
// never silently disagree.

function expectedCounts() {
  const allPickups = users.flatMap((u) => u.pickupHistory ?? []);
  const resolvable = allPickups.filter(
    (p) =>
      p.collectionId.toString() !== DANGLING.collection.toString() &&
      p.captain.toString() !== DANGLING.captain.toString(),
  );
  return {
    captains: captains.length,
    logistics: logistics.length,
    brands: brands.length,
    brandthemes: brandthemes.length,
    locations: locations.length,
    cities: locations.reduce((n, l) => n + l.cities.length, 0),
    towns: locations.reduce(
      (n, l) => n + l.cities.reduce((m, c) => m + c.towns.length, 0),
      0,
    ),
    users: users.length,
    collections: collections.length,
    collection_users: collections.reduce(
      (n, c) =>
        n +
        c.users.filter((u) => u.toString() !== DANGLING.user.toString()).length,
      0,
    ),
    collection_captains: collections.reduce(
      (n, c) =>
        n +
        c.captainsWithDates.filter(
          (x) => x.captain.toString() !== DANGLING.captain.toString(),
        ).length,
      0,
    ),
    pickups: resolvable.length,
    pickup_items: resolvable.reduce(
      (n, p) => n + (p.qrCodesWithWeights?.length ?? 0),
      0,
    ),
  };
}

function expectedWarnings() {
  return [
    "2 pickups skipped (1 dangling collectionId, 1 dangling captain)",
    "1 collection_users row skipped (dangling user ref)",
    "1 collection_captains row skipped (dangling captain ref)",
    "1 brands.legacy_brand_id left NULL (dangling legacyBrandId)",
  ];
}

// ---------------------------------------------------------------------------

const DROP = process.argv.includes("--drop");
const YES = process.argv.includes("--yes");

function printPlan() {
  console.log(
    `Target: ${redact(URI)}  (from ${URI_SOURCE}, db "${DB_NAME}")\n`,
  );
  console.log(
    "Documents this script owns (deterministic _ids under prefix " +
      `"${FIXTURE_PREFIX}"):`,
  );
  for (const [name, docs] of PLAN) console.log(`  ${name}: ${docs.length}`);
  console.log(
    "\nExpected ETL row-count DELTAS after seeding (added to whatever the",
  );
  console.log("target database already contains):");
  for (const [t, n] of Object.entries(expectedCounts()).sort())
    console.log(`  ${t}: +${n}`);
  console.log(
    "\nExpected NEW warnings (all deliberate — each proves a skip path works):",
  );
  for (const w of expectedWarnings()) console.log(`  - ${w}`);
}

async function main() {
  if (!DROP && !YES) {
    printPlan();
    console.log(
      "\nDry run only. Pass --yes to seed, or --drop to remove the fixtures.",
    );
    process.exit(0);
  }

  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db();

  // Always delete first — this is what makes the script idempotent. It removes
  // ONLY the deterministic fixture ids, never anything it did not create.
  let removed = 0;
  for (const [name] of PLAN) {
    const res = await db
      .collection(name)
      .deleteMany({ _id: { $in: ALL_FIXTURE_IDS } });
    removed += res.deletedCount;
  }
  console.log(`Removed ${removed} existing fixture document(s).`);

  if (DROP) {
    console.log("--drop: fixtures removed, nothing recreated.");
    await client.close();
    return;
  }

  for (const [name, docs] of PLAN) {
    if (!docs.length) continue;
    await db.collection(name).insertMany(docs);
    console.log(`  ${name}: inserted ${docs.length}`);
  }

  console.log("\nSeeded.\n");
  printPlan();
  console.log(
    "\nNext: apply scripts/postgres-normalized-schema.sql to an EMPTY database, then run\n" +
      "  node scripts/migrate-mongo-to-postgres-normalized.mjs --yes\n" +
      "and check the printed row counts against the deltas above.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
