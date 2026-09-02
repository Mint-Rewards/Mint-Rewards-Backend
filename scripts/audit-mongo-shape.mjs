#!/usr/bin/env node
// Read-only pre-flight audit: checks that every array/sub-document field
// scripts/migrate-mongo-to-postgres-normalized.mjs assumes a shape for
// actually has that shape in real MONGODB_URI_TEST data. Run this BEFORE
// the ETL — it makes no writes to Mongo or Postgres.
//
// The ETL's loops (`for (const x of doc.field ?? [])`) treat any *present*
// non-array value as unsupported: iterating a string yields one row per
// character, and iterating a number/object throws. Sub-document reads
// (`doc.field?.x`) are safe against `field` being absent, but a `field`
// that's present with a non-object primitive silently reads as `undefined`
// for every nested access, which drops data quietly instead of warning.
//
// Usage: node scripts/audit-mongo-shape.mjs

import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const MONGODB_URI_TEST = process.env.MONGODB_URI_TEST;
if (!MONGODB_URI_TEST) {
  console.error("MONGODB_URI_TEST is not set — define it in .env.");
  process.exit(1);
}

// Same guard as the ETL: refuse to point this at a non-test database.
const looksLikeTestUri = (uri) => /(^|[-_/])test(?=[-_/?]|$)/i.test(uri);
if (!looksLikeTestUri(MONGODB_URI_TEST)) {
  console.error(
    "Refusing to run: MONGODB_URI_TEST does not look like a test database URI.",
  );
  process.exit(1);
}

// collection -> { field: "array" | "object" }
// Only top-level fields the ETL reads directly; nested array/object fields
// inside them (materialBreakdown, qrCodesWithWeights, permissions,
// structuredAddress, etc.) are checked separately, scoped to parent
// entries that are themselves well-shaped.
const EXPECTATIONS = {
  organizations: { moduleSubscriptions: "array" },
  locations: { cities: "array" },
  users: {
    referrals: "array",
    pickupHistory: "array",
    location: "object",
    structuredAddress: "object",
    locationVerification: "object",
    passwordReset: "object",
    emailVerification: "object",
  },
  brands: {
    environmentalStats: "object",
    environmentalPeriods: "array",
  },
  campaigns: {
    discountCodes: "array",
    addresses: "array",
    users: "array",
  },
  collections: {
    users: "array",
    captainsWithDates: "array",
  },
  deals: {
    codes: "array",
    users: "array",
    claims: "array",
  },
  brandusers: {
    moduleAccess: "array",
  },
};

// Collections with a target table but no array/sub-document field to
// validate (flat 1:1 mappings) — not in EXPECTATIONS, but not "uncovered".
const FLAT_MAPPED_COLLECTIONS = new Set(["brandthemes", "captains", "logistics"]);

function typeOf(v) {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v; // "string" | "number" | "boolean" | ...
}

function isAnomalous(actual, expected) {
  if (actual === "missing" || actual === "null") return false; // handled fine by ?? [] / ?.
  return actual !== expected;
}

async function main() {
  const client = new MongoClient(MONGODB_URI_TEST, {
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  const db = client.db();
  console.log(`Auditing ${db.databaseName} against ETL shape assumptions...\n`);

  const knownCollections = new Set([
    ...Object.keys(EXPECTATIONS),
    ...FLAT_MAPPED_COLLECTIONS,
  ]);
  const actualCollections = (await db.listCollections().toArray()).map((c) => c.name);
  const uncovered = actualCollections.filter(
    (n) => !knownCollections.has(n) && n !== "logs",
  );

  let totalAnomalies = 0;

  for (const [collName, fields] of Object.entries(EXPECTATIONS)) {
    const coll = db.collection(collName);
    const total = await coll.countDocuments();
    const tally = {}; // field -> { [actualType]: count }
    const samples = {}; // field -> [ _id, ... ] (first 5 anomalous)

    for (const field of Object.keys(fields)) {
      tally[field] = {};
      samples[field] = [];
    }

    const cursor = coll.find(
      {},
      { projection: Object.fromEntries(Object.keys(fields).map((f) => [f, 1])) },
    );
    for await (const doc of cursor) {
      for (const [field, expected] of Object.entries(fields)) {
        const actual = typeOf(doc[field]);
        tally[field][actual] = (tally[field][actual] ?? 0) + 1;
        if (isAnomalous(actual, expected) && samples[field].length < 5) {
          samples[field].push(doc._id);
        }
      }
    }

    const fieldAnomalyCounts = Object.entries(fields)
      .map(([field, expected]) => {
        const anomalyCount = Object.entries(tally[field])
          .filter(([actual]) => isAnomalous(actual, expected))
          .reduce((sum, [, n]) => sum + n, 0);
        return [field, expected, anomalyCount];
      })
      .filter(([, , n]) => n > 0);

    console.log(`${collName} (${total} docs)`);
    if (fieldAnomalyCounts.length === 0) {
      console.log("  clean — every field matches its expected shape (or is absent/null)\n");
      continue;
    }
    for (const [field, expected, n] of fieldAnomalyCounts) {
      totalAnomalies += n;
      const breakdown = Object.entries(tally[field])
        .filter(([actual]) => isAnomalous(actual, expected))
        .map(([actual, count]) => `${actual}:${count}`)
        .join(", ");
      console.log(
        `  ! ${field}: expected ${expected}, found ${n} anomalous doc(s) [${breakdown}] — e.g. _id ${samples[field].slice(0, 3).join(", ")}`,
      );
    }
    console.log();
  }

  // Nested per-entry checks: the ETL also reads fields *inside* array
  // entries and sub-documents (qrCodesWithWeights per pickup, permissions
  // per moduleAccess entry, materialBreakdown per stats/period entry).
  // A top-level array being correctly typed doesn't guarantee its entries
  // are shaped as expected.
  async function auditNested(collName, label, extractEntries) {
    const coll = db.collection(collName);
    let checked = 0;
    let anomalyCount = 0;
    const samples = [];
    for await (const doc of coll.find()) {
      for (const { path, value, expected } of extractEntries(doc)) {
        checked++;
        const actual = typeOf(value);
        if (isAnomalous(actual, expected)) {
          anomalyCount++;
          if (samples.length < 5) {
            samples.push(`${collName}/${doc._id} ${path}: expected ${expected}, got ${actual}`);
          }
        }
      }
    }
    console.log(`${label} (${checked} entries checked)`);
    if (anomalyCount === 0) {
      console.log("  clean\n");
    } else {
      for (const s of samples) console.log(`  ! ${s}`);
      console.log();
    }
    return anomalyCount;
  }

  totalAnomalies += await auditNested(
    "users",
    "users.pickupHistory[] entry shapes (qrCodesWithWeights, addressSnapshot)",
    (doc) =>
      (Array.isArray(doc.pickupHistory) ? doc.pickupHistory : []).flatMap((entry, i) => [
        {
          path: `pickupHistory[${i}].qrCodesWithWeights`,
          value: entry.qrCodesWithWeights,
          expected: "array",
        },
        {
          path: `pickupHistory[${i}].addressSnapshot`,
          value: entry.addressSnapshot,
          expected: "object",
        },
      ]),
  );

  totalAnomalies += await auditNested(
    "brandusers",
    "brandusers.moduleAccess[] entry shapes (permissions)",
    (doc) =>
      (Array.isArray(doc.moduleAccess) ? doc.moduleAccess : []).map((entry, i) => ({
        path: `moduleAccess[${i}].permissions`,
        value: entry.permissions,
        expected: "array",
      })),
  );

  totalAnomalies += await auditNested(
    "brands",
    "brands materialBreakdown[] shapes (environmentalStats + environmentalPeriods[])",
    (doc) => {
      const out = [];
      if (doc.environmentalStats) {
        out.push({
          path: "environmentalStats.materialBreakdown",
          value: doc.environmentalStats.materialBreakdown,
          expected: "array",
        });
      }
      for (const [i, period] of (doc.environmentalPeriods ?? []).entries()) {
        out.push({
          path: `environmentalPeriods[${i}].materialBreakdown`,
          value: period.materialBreakdown,
          expected: "array",
        });
      }
      return out;
    },
  );

  totalAnomalies += await auditNested(
    "deals",
    "deals.claims[] entry shapes (user, code)",
    (doc) =>
      (Array.isArray(doc.claims) ? doc.claims : []).flatMap((entry, i) => [
        { path: `claims[${i}].user`, value: entry.user, expected: "object" }, // ObjectId
        { path: `claims[${i}].code`, value: entry.code, expected: "string" },
      ]),
  );

  console.log("=== Summary ===");
  console.log(`Total anomalous field values: ${totalAnomalies}`);
  if (uncovered.length > 0) {
    console.log(
      `Collections present in Mongo with no target table in the schema (not migrated, ` +
        `not audited above — confirm this is intentional): ${uncovered.join(", ")}`,
    );
  }

  await client.close();
  process.exit(totalAnomalies > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
