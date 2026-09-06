// Nightly reconciliation for the dual-write window.
//
// During the 30-day window Mongo stays authoritative and every write is
// mirrored into Postgres. A failed shadow write leaves NO trace in the
// user-visible path, so without this job the window produces confidence
// rather than evidence and the rollback trigger cannot fire. This is the
// thing that makes "successful" falsifiable on any given day.
//
// READ-ONLY against both databases. It is safe to point at production, and
// it has no --yes guard for that reason.
//
// The column list comes from information_schema rather than a hand-written
// map: a second copy of the field mapping would drift from the ETL's, and a
// reconciler that agrees with a stale map reports success it has not earned.
// Mongo field names are derived by camel-casing the column, which covers
// almost every column as written; the exceptions are declared in NESTED below.
//
// Usage:
//   node scripts/reconcile-mongo-postgres.mjs
//   node scripts/reconcile-mongo-postgres.mjs --table users --limit 500
//   node scripts/reconcile-mongo-postgres.mjs --json      # for cron/alerting
//
// Exit codes: 0 clean · 1 divergence found · 2 could not run.

import "dotenv/config";
import { MongoClient } from "mongodb";
import pg from "pg";

const MONGO_URI = process.env.RECONCILE_MONGODB_URI || process.env.MONGODB_URI;
const PG_URL = process.env.RECONCILE_POSTGRES_URL || process.env.POSTGRES_URL;

/** Postgres table -> the Mongo collection it mirrors, 1:1 on _id. */
const ENTITIES = {
  users: "users",
  brands: "brands",
  campaigns: "campaigns",
  deals: "deals",
  organizations: "organizations",
  brandusers: "brandusers",
  brandthemes: "brandthemes",
  logistics: "logistics",
  locations: "locations",
};

/**
 * Columns whose value does not come from a same-named top-level Mongo field.
 * Anything not listed is `camelCase(column)` on the document root.
 */
const NESTED = {
  user_locations: {
    collection: "users",
    // Keyed on the parent's _id, so the row is present iff the user has any
    // location data at all — the ETL's `hasLocationData` condition.
    key: "user_id",
    present: (d) =>
      Boolean(d.location || d.structuredAddress || d.locationVerification ||
              d.locationCompletedAt || (d.locationVersion ?? 0) > 0),
    fields: {
      lng: (d) => d.location?.coordinates?.[0],
      lat: (d) => d.location?.coordinates?.[1],
      source: (d) => d.location?.source,
      precision: (d) => d.location?.precision,
      accuracy_meters: (d) => d.location?.accuracyMeters,
      captured_at: (d) => d.location?.capturedAt,
      structured_city_id: (d) => d.structuredAddress?.cityId,
      structured_area_id: (d) => d.structuredAddress?.areaId,
      structured_block_id: (d) => d.structuredAddress?.blockId,
      structured_area_other: (d) => d.structuredAddress?.areaOther,
      structured_block_other: (d) => d.structuredAddress?.blockOther,
      structured_house_no: (d) => d.structuredAddress?.houseNo,
      structured_street_or_block: (d) => d.structuredAddress?.streetOrBlock,
      version: (d) => d.locationVersion ?? 0,
      completed_at: (d) => d.locationCompletedAt,
      verification_status: (d) => d.locationVerification?.status,
      verification_method: (d) => d.locationVerification?.method,
      verification_geocoded_area_raw: (d) => d.locationVerification?.geocodedAreaRaw,
      verification_geocoded_area_id: (d) => d.locationVerification?.geocodedAreaId,
      verification_selected_area_id: (d) => d.locationVerification?.selectedAreaId,
      verification_distance_meters: (d) => d.locationVerification?.distanceMeters,
      verification_checked_at: (d) => d.locationVerification?.checkedAt,
      verification_resolved_by: (d) => d.locationVerification?.resolvedBy,
    },
  },
};

/** Never read, never compared, never printed. */
const SECRET_COLUMNS = new Set(["password", "password_hash", "otp_hash"]);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const only = argValue("--table");
const limit = Number(argValue("--limit")) || 0;

function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function camel(col) {
  return col.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** What Postgres would store for a value the document does not carry. */
function applyDefault(value, col) {
  if (value !== undefined && value !== null) return value;
  if (col.default === null) return null;
  return col.default;
}

/** One comparable shape for both sides. */
function norm(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && typeof v.toHexString === "function") return v.toHexString();
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v;
  // Postgres numeric comes back as a string; Mongo holds a number.
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (typeof v === "string") {
    // timestamptz round-trips through pg as a Date already; this catches
    // date-like text columns.
    const d = Date.parse(v);
    if (!Number.isNaN(d) && /\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toISOString();
    return v;
  }
  return JSON.stringify(v);
}

function equal(a, b) {
  const x = norm(a), y = norm(b);
  if (typeof x === "number" && typeof y === "number") return Math.abs(x - y) < 1e-9;
  return x === y;
}

/**
 * Foreign keys, so a reference Mongo carries but Postgres could not resolve is
 * read as what it is. The ETL nulls a dangling reference rather than aborting;
 * an unresolvable id is a fact about the source data, not a lost write, and
 * counting it as divergence would make every run fail forever.
 */
async function foreignKeysOf(pgc, table) {
  const { rows } = await pgc.query(
    `SELECT kcu.column_name, ccu.table_name AS target
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_name=$1`,
    [table],
  );
  return new Map(rows.map((r) => [r.column_name, r.target]));
}

const idCache = new Map();
async function idsOf(pgc, table) {
  if (!idCache.has(table)) {
    const { rows } = await pgc.query(`SELECT id FROM "${table}"`);
    idCache.set(table, new Set(rows.map((r) => String(r.id))));
  }
  return idCache.get(table);
}

async function columnsOf(pgc, table) {
  const { rows } = await pgc.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position`,
    [table],
  );
  return rows
    .filter((r) => !SECRET_COLUMNS.has(r.column_name))
    .map((r) => {
      let dflt = null;
      const d = r.column_default;
      if (d && /^'(.*)'::/.test(d)) dflt = d.replace(/^'(.*)'::.*$/s, "$1");
      else if (d === "false") dflt = false;
      else if (d === "true") dflt = true;
      else if (d && /^-?\d+$/.test(d)) dflt = Number(d);
      return { name: r.column_name, default: dflt, nullable: r.is_nullable === "YES" };
    });
}

async function main() {
  if (!MONGO_URI || !PG_URL) {
    console.error(
      "Set MONGODB_URI (or RECONCILE_MONGODB_URI) and POSTGRES_URL (or\n" +
        "RECONCILE_POSTGRES_URL). Both are read only here.",
    );
    process.exit(2);
  }

  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const db = mongo.db();
  const pgc = new pg.Client({ connectionString: PG_URL });
  await pgc.connect();

  const report = { startedAt: new Date().toISOString(), tables: {}, divergent: 0 };

  const targets = Object.entries(ENTITIES).filter(([t]) => !only || t === only);
  for (const [table, collection] of targets) {
    const cols = await columnsOf(pgc, table);
    const fks = await foreignKeysOf(pgc, table);

    const cursor = db.collection(collection).find({});
    if (limit) cursor.limit(limit);
    const docs = await cursor.toArray();

    const { rows } = await pgc.query(`SELECT * FROM "${table}"`);
    const pgById = new Map(rows.map((r) => [String(r.id), r]));

    const missingInPg = [], extraInPg = [], mismatches = [];
    let orphanedRefs = 0;
    for (const doc of docs) {
      const id = String(doc._id);
      const row = pgById.get(id);
      if (!row) { missingInPg.push(id); continue; }
      pgById.delete(id);
      for (const col of cols) {
        if (col.name === "id") continue;
        const expected = applyDefault(doc[camel(col.name)], col);
        if (equal(expected, row[col.name])) continue;

        // A dangling reference: Mongo names a target that was never migrated,
        // so Postgres holds NULL. Expected, and reported separately.
        const target = fks.get(col.name);
        if (target && row[col.name] === null && expected != null) {
          if (!(await idsOf(pgc, target)).has(String(norm(expected)))) {
            orphanedRefs += 1;
            continue;
          }
        }
        mismatches.push({ id, column: col.name });
      }
    }
    if (!limit) extraInPg.push(...pgById.keys());

    const bad = missingInPg.length + extraInPg.length + mismatches.length;
    if (bad) report.divergent += 1;
    report.tables[table] = {
      mongo: docs.length, postgres: rows.length,
      missingInPg: missingInPg.length, extraInPg: extraInPg.length,
      mismatches: mismatches.length, orphanedRefs,
      examples: {
        missingInPg: missingInPg.slice(0, 5),
        extraInPg: extraInPg.slice(0, 5),
        mismatches: mismatches.slice(0, 10),
      },
    };
  }

  // Nested one-to-one children, keyed on the parent document.
  for (const [table, spec] of Object.entries(NESTED)) {
    if (only && table !== only) continue;
    const cols = await columnsOf(pgc, table);
    const docs = await db.collection(spec.collection).find({}).toArray();
    const { rows } = await pgc.query(`SELECT * FROM "${table}"`);
    const pgByKey = new Map(rows.map((r) => [String(r[spec.key]), r]));

    const missingInPg = [], mismatches = [];
    let expectedRows = 0;
    for (const doc of docs) {
      if (!spec.present(doc)) continue;
      expectedRows += 1;
      const id = String(doc._id);
      const row = pgByKey.get(id);
      if (!row) { missingInPg.push(id); continue; }
      pgByKey.delete(id);
      for (const col of cols) {
        const get = spec.fields[col.name];
        if (!get) continue;
        if (!equal(applyDefault(get(doc), col), row[col.name])) {
          mismatches.push({ id, column: col.name });
        }
      }
    }
    const extraInPg = [...pgByKey.keys()];
    const bad = missingInPg.length + extraInPg.length + mismatches.length;
    if (bad) report.divergent += 1;
    report.tables[table] = {
      mongo: expectedRows, postgres: rows.length,
      missingInPg: missingInPg.length, extraInPg: extraInPg.length,
      mismatches: mismatches.length,
      examples: {
        missingInPg: missingInPg.slice(0, 5),
        extraInPg: extraInPg.slice(0, 5),
        mismatches: mismatches.slice(0, 10),
      },
    };
  }

  await mongo.close();
  await pgc.end();

  report.finishedAt = new Date().toISOString();
  report.ok = report.divergent === 0;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nreconciliation — ${report.startedAt}`);
    console.log(`source ${db.databaseName}   target ${new URL(PG_URL).pathname.slice(1)}`);
    if (limit) console.log(`sampling the first ${limit} documents per collection\n`);
    else console.log();
    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad("table", 22) + pad("mongo", 8) + pad("pg", 8) + pad("missing", 9) + pad("extra", 7) + pad("fields", 8) + "orphan refs");
    for (const [t, r] of Object.entries(report.tables)) {
      const flag = r.missingInPg || r.extraInPg || r.mismatches ? "  <--" : "";
      console.log(pad(t, 22) + pad(r.mongo, 8) + pad(r.postgres, 8) +
                  pad(r.missingInPg, 9) + pad(r.extraInPg, 7) +
                  pad(r.mismatches, 8) + (r.orphanedRefs ?? 0) + flag);
    }
    for (const [t, r] of Object.entries(report.tables)) {
      if (!r.mismatches && !r.missingInPg && !r.extraInPg) continue;
      console.log(`\n${t}:`);
      if (r.examples.missingInPg.length)
        console.log(`  in Mongo, absent from Postgres: ${r.examples.missingInPg.join(", ")}`);
      if (r.examples.extraInPg.length)
        console.log(`  in Postgres, absent from Mongo: ${r.examples.extraInPg.join(", ")}`);
      for (const m of r.examples.mismatches)
        console.log(`  ${m.id} differs on ${m.column}`);
    }
    console.log(
      report.ok
        ? "\nClean. Mongo and Postgres agree — rollback remains unnecessary and the window can continue."
        : `\n${report.divergent} table(s) diverged. Dual-write is losing writes; this is the rollback trigger.`,
    );
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
