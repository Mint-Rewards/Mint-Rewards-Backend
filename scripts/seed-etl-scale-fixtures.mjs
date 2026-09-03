#!/usr/bin/env node
// Generates a PRODUCTION-SCALE synthetic dataset so the normalized ETL can be
// timed before a real cutover. The number this exists to produce is the
// WRITE-FREEZE WINDOW: the ETL is a point-in-time snapshot, so any write that
// lands in Mongo after it reads a collection is silently lost. The freeze is
// the entire data-loss protection, and its length is the ETL's runtime.
//
// Shape is modelled on real production figures (~7,200 users, very few deals)
// rather than on the test cluster, whose 266 deals / 26,559 deal codes were
// test churn and badly misrepresent the real workload.
//
// Child-array ratios are taken from the real test cluster, which is the only
// real distribution available:
//   users with a location block   9/42  ~= 21%
//   users with an OTP flow       13/42  ~= 31%
//   referrals per user           11/42  ~= 0.26
// pickupHistory is left EMPTY deliberately: it is empty on every real user and
// no route handler in either repo writes it, so a realistic production
// rehearsal must migrate zero pickups.
//
// Usage:
//   node scripts/seed-etl-scale-fixtures.mjs                 # dry run, prints plan
//   node scripts/seed-etl-scale-fixtures.mjs --yes
//   node scripts/seed-etl-scale-fixtures.mjs --yes --users 7200 --deal-codes 1000
//   node scripts/seed-etl-scale-fixtures.mjs --drop
//
// Point ETL_FIXTURES_MONGODB_URI at a DEDICATED database (the name must still
// contain "test"). Deterministic ids under the "e7e" prefix, so --drop removes
// exactly what this created and nothing else.

import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const URI = process.env.ETL_FIXTURES_MONGODB_URI || process.env.MONGODB_URI_TEST;
const URI_SOURCE = process.env.ETL_FIXTURES_MONGODB_URI
  ? "ETL_FIXTURES_MONGODB_URI"
  : "MONGODB_URI_TEST";
if (!URI) {
  console.error("Set ETL_FIXTURES_MONGODB_URI or MONGODB_URI_TEST.");
  process.exit(1);
}
const DB_NAME = (URI.match(/\/([^/?]+)(\?|$)/) || [])[1] || "";
if (!/(^|[-_])test([-_]|$)|^test_db$/i.test(DB_NAME)) {
  console.error(
    `Refusing to run: ${URI_SOURCE} points at "${DB_NAME}", which does not look ` +
      `like a test database.`,
  );
  process.exit(1);
}

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const USERS = arg("--users", 7200);
const DEAL_CODES = arg("--deal-codes", 1000);
const DROP = process.argv.includes("--drop");
const YES = process.argv.includes("--yes");

// Deterministic ids: "e7e" + zero-padded ordinal. Distinct from the "e7f"
// prefix used by seed-etl-pickup-fixtures.mjs so the two never collide and
// each script's --drop only ever removes its own documents.
const PREFIX = "e7e";
let ord = 0;
const fid = () => new ObjectId(PREFIX + String(++ord).padStart(21, "0"));

const now = new Date("2026-09-03T03:00:00.000Z");

const orgId = fid();
const brandId = fid();
const dealId = fid();

const organizations = [
  {
    _id: orgId,
    name: "Scale Test Org",
    plan: "starter",
    moduleSubscriptions: [
      { module: "consumer-reporting", status: "active", activatedAt: now },
    ],
    createdAt: now,
    updatedAt: now,
  },
];

const brands = [
  {
    _id: brandId,
    orgId,
    companyName: "Scale Test Brand Ltd",
    brandName: "Scale Test Brand",
    email: "scale-test-brand@example.test",
    category: "Retail",
    webLink: "https://example.test",
    contactName: "Contact",
    phone: "+92 300 0000000",
    registrationNumber: "SCALE-TEST-REG-1",
    domain: "example.test",
    themeColor: "#00A86B",
    status: "APPROVED",
    role: "BRAND",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  },
];

// One active deal, matching production. `codes` is the parameter most likely to
// be wrong in either direction — a single-code deal is 1 row, a bulk-issued one
// can be tens of thousands. Override with --deal-codes once the real figure is
// known; it is the main lever on total insert count after users.
const deals = [
  {
    _id: dealId,
    brand: brandId,
    title: "Scale Test Deal",
    description: "The single active production-shaped deal.",
    status: "active",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    codes: Array.from({ length: DEAL_CODES }, (_, i) => ({
      code: `SCALE${String(i).padStart(7, "0")}`,
    })),
    users: [],
    claims: [],
  },
];

function makeUser(i) {
  const id = fid();
  const u = {
    _id: id,
    userName: `Scale User ${i}`,
    email: `scale-user-${i}@example.test`,
    password: "$2a$10$scaletesthashnotarealpassword00000000000000000000000",
    avatar: "",
    address: `House ${i}`,
    province: "Sindh",
    city: "Karachi",
    town: "Gulshan-e-Iqbal Block 8",
    townOther: "",
    subArea: "",
    subAreaOther: "",
    phone: `+9230000${String(i).padStart(5, "0")}`,
    mintId: `SCALE${String(i).padStart(8, "0")}`,
    role: "MEMBER",
    latitude: "",
    longitude: "",
    deviceToken: "",
    points: 100,
    totalCollections: "",
    totalWasteCollected: "",
    referrals: [],
    referralRewardGranted: false,
    // Empty on every real user, and nothing writes it — a realistic rehearsal
    // must migrate zero pickups.
    pickupHistory: [],
    created: now,
    firstTimeLogin: false,
  };

  // ~0.26 referrals per user (test-cluster ratio), clustered rather than spread
  // evenly: every 4th user carries one.
  if (i % 4 === 0) u.referrals = [`referred-${i}@example.test`];

  // ~21% have a location block -> one user_locations row each.
  if (i % 5 === 0) {
    u.location = {
      type: "Point",
      coordinates: [67.0822, 24.9204],
      source: "map_pin",
      precision: "building",
      accuracyMeters: 12,
      capturedAt: now,
    };
    u.structuredAddress = {
      cityId: "Karachi",
      areaId: "Gulshan-e-Iqbal",
      blockId: "Block 8",
      houseNo: String(i),
      streetOrBlock: "Street 1",
    };
    u.locationVerification = {
      status: "auto_verified",
      method: "reverse_geocode",
      selectedAreaId: "Gulshan-e-Iqbal",
      checkedAt: now,
    };
    u.locationVersion = 1;
    u.locationCompletedAt = now;
  }

  // ~31% have an OTP flow -> one user_otp_flows row each.
  if (i % 3 === 0) {
    u.emailVerification = {
      otpHash: "scale-test-hash",
      expiresAt: now,
      attempts: 0,
      lastSentAt: now,
    };
  }

  return u;
}

function plan() {
  const users = USERS;
  const referrals = Math.floor(users / 4);
  const locations = Math.floor(users / 5);
  const otp = Math.floor(users / 3);
  const total =
    users + referrals + locations + otp + DEAL_CODES + 1 + 1 + 1 + 1;
  return { users, referrals, locations, otp, dealCodes: DEAL_CODES, total };
}

function printPlan() {
  const p = plan();
  console.log(`Target: ${URI.replace(/\/\/[^@]+@/, "//<redacted>@")}  (db "${DB_NAME}")\n`);
  console.log("Synthetic production-shaped dataset:");
  console.log(`  users                 ${p.users}`);
  console.log(`  user_referrals        ${p.referrals}`);
  console.log(`  user_locations        ${p.locations}`);
  console.log(`  user_otp_flows        ${p.otp}`);
  console.log(`  deal_codes            ${p.dealCodes}`);
  console.log(`  organizations/brands/deals/org_module_subs  1 each`);
  console.log(`  pickups               0   (empty in production; nothing writes it)`);
  console.log(
    `\n  => ~${p.total} INSERT round-trips. The ETL awaits one round-trip per row,\n` +
      `     so runtime ~= ${p.total} x per-round-trip latency to the TARGET Postgres.`,
  );
}

async function main() {
  if (!DROP && !YES) {
    printPlan();
    console.log("\nDry run. Pass --yes to seed, or --drop to remove.");
    process.exit(0);
  }

  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db();
  const collections = ["organizations", "brands", "deals", "users"];

  const idFilter = { _id: { $regex: undefined } };
  void idFilter;
  let removed = 0;
  for (const name of collections) {
    // Deterministic prefix -> an _id range delete, so only this script's own
    // documents are ever touched.
    const res = await db.collection(name).deleteMany({
      _id: {
        $gte: new ObjectId(PREFIX + "0".repeat(21)),
        $lt: new ObjectId("e7f" + "0".repeat(21)),
      },
    });
    removed += res.deletedCount;
  }
  console.log(`Removed ${removed} existing scale document(s).`);
  if (DROP) {
    await client.close();
    return;
  }

  await db.collection("organizations").insertMany(organizations);
  await db.collection("brands").insertMany(brands);
  await db.collection("deals").insertMany(deals);

  const BATCH = 1000;
  let batch = [];
  for (let i = 1; i <= USERS; i++) {
    batch.push(makeUser(i));
    if (batch.length === BATCH) {
      await db.collection("users").insertMany(batch);
      process.stdout.write(`\r  users inserted: ${i}/${USERS}`);
      batch = [];
    }
  }
  if (batch.length) await db.collection("users").insertMany(batch);
  process.stdout.write(`\r  users inserted: ${USERS}/${USERS}\n`);

  console.log("\nSeeded.\n");
  printPlan();
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
