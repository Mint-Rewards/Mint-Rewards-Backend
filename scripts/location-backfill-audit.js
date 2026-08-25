// P3.1 — read-only backfill audit for the location-capture project.
//
// WHY: before any migration touches the `users` collection, we need to know
// what state existing addresses are actually in — how many carry a
// now-deprecated sub-area value, how many name a town the registry no longer
// (or never did) recognise, how many have no usable pin at all, and — for
// the ones that DO have both a stated town and a pin — how far the pin sits
// from that town's surveyed centroid. This script answers all of that in one
// read-only pass, plus two counts owed from earlier open items (P0.5, P0.4b).
//
// READ-ONLY, ABSOLUTELY. This script performs no write of any kind to any
// database — no updateOne, no updateMany, no $set. It only reads `users`
// and writes local report files. No geocoding calls either: bucketing is
// centroid-distance only, against the registry's OWN surveyed centroids
// (`utils/__generated__/... areaCentroids`, currently empty — see the
// `--centroids` flag below). This is a settled ruling from the P0.6 sweep
// report (Mint-Rewards-App/scripts/geocode-spike/P0.6-REPORT.md): bucketing
// on live geocoder agreement would misfile a large share of
// correctly-addressed users as "disagree", because a geocoder returning a
// finer-but-correct neighbourhood ("Clifton -> Bath Island") looks
// identical, from an agreement standpoint, to a genuinely wrong answer.
//
// LANGUAGE DISCIPLINE (verbatim requirement, carried into every report this
// script produces — see `buildReportHeader` below): "disagree" here means
// ONLY that the stored pin sits farther from the stated town's centroid than
// the chosen containment threshold. It is NOT a determination that the
// user's address is wrong, and this script's disagree count must NEVER be
// read or reported as a geocoder error rate — no geocoder call is even made.
//
// THRESHOLD IS PROVISIONAL. The P0.1a sweep's `maxSampleRadiusMeters` is the
// spread of a hand-drawn sampling box, not a validated containment bound
// (report.js's own centroids.json caveat says so explicitly). This script's
// default heuristic (max sample radius x 1.5, floored at 2 km) is a
// documented placeholder pending the P0.1b boundary-derived threshold, and
// is overridable via `--threshold-km` for exactly that reason.
//
// GATING mirrors this repo's own precedent, scripts/backfill-referral-reward-granted.js:
//   --target=production|test is required (no default — the failure mode
//   guarded against is an accidental run against the wrong database), and
//   the connected database's actual name is asserted against the target
//   AFTER connecting (the URI variable and the database it resolves to are
//   independent facts).
//
// RESUMABLE. A production run over a large collection may need to chunk
// across sessions: a checkpoint file records the last processed `_id` (the
// natural insertion-order cursor) and per-user results are appended to an
// NDJSON sidecar as they are produced, so a restart resumes the Mongo scan
// from where it left off instead of re-reading everything already recorded.
// On successful completion the NDJSON is aggregated into the final
// audit-report.json and both scratch files are removed.
//
// Usage:
//   node scripts/location-backfill-audit.js --target=test
//   node scripts/location-backfill-audit.js --target=test --threshold-km=3
//   node scripts/location-backfill-audit.js --target=test --centroids=./scripts/data/centroids.json
//   node scripts/location-backfill-audit.js --target=production --out=./scripts/out/audit-report.json
//
// Do NOT run with --target=production without the repo owner's explicit
// go-ahead — this script is read-only, but a production run is still a
// deliberate, owner-approved event per the task brief.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();

// ---------------------------------------------------------------------------
// The location registry artifact (P3.1 extension: deprecatedSubAreas, areaCentroids)
// ---------------------------------------------------------------------------

/** @typedef {readonly [number, number]} LngLat */

/**
 * @typedef {object} RegistryArtifact
 * @property {number} version
 * @property {Record<string, { towns: string[]; deprecatedTowns: string[] }>} cities
 * @property {Record<string, string[]>} deprecatedSubAreas
 * @property {{ areas: Record<string, LngLat>; cities: Record<string, LngLat> }} areaCentroids
 */

/** @type {RegistryArtifact} */
const registryArtifact = require("../lib/data/locationRegistry.json");

// ---------------------------------------------------------------------------
// Pure helpers — exported for the jest suite. NONE of these touch Mongo.
// ---------------------------------------------------------------------------

const BUCKETS = /** @type {const} */ ([
  "deprecated_sub_area",
  "unresolvable",
  "no_pin",
  "no_centroid",
  "agree",
  "disagree",
]);

/** Composite key, identical convention to the app's `subAreaKey`. */
function cityTownKey(city, town) {
  return `${city}::${town}`;
}

/** Rounds to 3 decimal places (~111m at the equator) for coordinate dedup. */
function roundCoordinate(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Parses a user's usable coordinate, preferring the structured GeoJSON
 * `location.coordinates` ([lng, lat]) and falling back to the legacy
 * `latitude`/`longitude` strings (plain human lat-then-lng order) only when
 * the structured field is absent or malformed.
 *
 * This mirrors lib/pickupSnapshot.ts's `buildPickupAddressSnapshot` exactly,
 * on purpose: that function is the one other place in this repo that
 * reconciles the same two representations, and the two must never disagree
 * about which one wins. The "GeoJSON-vs-string mismatch trap" the task
 * brief warns about is exactly this: `location.coordinates` is
 * [lng, lat] while the legacy pair is (latitude, longitude) — conflating the
 * two orderings, or trusting an empty/partial `location.coordinates` over a
 * valid legacy pair, silently produces a wrong point instead of a missing
 * one.
 *
 * @returns {{ lat: number; lng: number } | null}
 */
function parseUserCoordinates(user) {
  const coords = user?.location?.coordinates;
  if (
    Array.isArray(coords) &&
    coords.length === 2 &&
    coords.every((c) => typeof c === "number" && Number.isFinite(c))
  ) {
    const [lng, lat] = coords;
    return { lat, lng };
  }

  const lat = parseFloat(user?.latitude ?? "");
  const lng = parseFloat(user?.longitude ?? "");
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }

  return null;
}

/** Great-circle distance in meters between two {lat,lng} points (haversine). */
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const DEFAULT_THRESHOLD_MULTIPLIER = 1.5;
const DEFAULT_THRESHOLD_FLOOR_METERS = 2000;

/**
 * The containment threshold for one town's centroid check, in meters.
 *
 * With no override: max(maxSampleRadiusMeters x 1.5, 2000) — PROVISIONAL,
 * see this file's header. With `thresholdKmOverride` given (the
 * `--threshold-km` flag): that fixed value applies to every town uniformly,
 * bypassing the per-town radius heuristic entirely.
 */
function computeContainmentThresholdMeters(
  maxSampleRadiusMeters,
  thresholdKmOverride,
) {
  if (
    typeof thresholdKmOverride === "number" &&
    Number.isFinite(thresholdKmOverride)
  ) {
    return thresholdKmOverride * 1000;
  }
  const heuristic = maxSampleRadiusMeters * DEFAULT_THRESHOLD_MULTIPLIER;
  return Math.max(heuristic, DEFAULT_THRESHOLD_FLOOR_METERS);
}

/**
 * Builds the bucketing context from the raw registry artifact plus an
 * optional centroid override (the `--centroids` flag, or a test fixture).
 *
 * `overrideCentroids`, when given, REPLACES the artifact's `areaCentroids`
 * entirely (it does not merge) — the flag exists for the case where the
 * artifact ships empty (true today) and a separately-produced
 * `centroids.json` (P0.1a sweep by-product) needs to be exercised without a
 * registry re-export.
 *
 * @param {RegistryArtifact} artifact
 * @param {Record<string, { centroid: LngLat; maxSampleRadiusMeters: number }>} [overrideCentroids]
 */
function buildRegistryContext(artifact, overrideCentroids) {
  /** @type {Record<string, { towns: Set<string>; deprecatedTowns: Set<string> }>} */
  const citiesTowns = {};
  for (const [city, entry] of Object.entries(artifact.cities)) {
    citiesTowns[city] = {
      towns: new Set(entry.towns),
      deprecatedTowns: new Set(entry.deprecatedTowns),
    };
  }

  /** @type {Record<string, Set<string>>} */
  const deprecatedSubAreas = {};
  for (const [key, values] of Object.entries(artifact.deprecatedSubAreas)) {
    deprecatedSubAreas[key] = new Set(values);
  }

  // The committed artifact's `areaCentroids.areas` stores bare [lng, lat]
  // pairs (mirroring the app's `AREA_CENTROIDS` shape) with no sample-radius
  // field at all — there is no containment threshold that can be derived
  // from it. So it is intentionally NOT wired into `centroids` here: without
  // a `--centroids` override supplying a real centroids.json-shaped file
  // (centroid + maxSampleRadiusMeters per town), every town falls through to
  // `no_centroid` rather than a distance computed against an unbounded
  // guess. `overrideCentroids` REPLACES this entirely, it does not merge.
  const centroids = overrideCentroids || {};

  return { citiesTowns, deprecatedSubAreas, centroids };
}

/**
 * Loads a `--centroids <path>` override file. Accepts either the bare
 * `{ "City::Town": { centroid, maxSampleRadiusMeters, ... } }` shape or the
 * P0.1a sweep's own `report.js` output shape
 * (`{ _CAVEAT: [...], centroids: { ... } }`) — whichever is handed in.
 */
function loadCentroidsOverride(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const map = raw && typeof raw === "object" && raw.centroids ? raw.centroids : raw;

  /** @type {Record<string, { centroid: LngLat; maxSampleRadiusMeters: number }>} */
  const out = {};
  for (const [key, entry] of Object.entries(map)) {
    if (
      !entry ||
      !Array.isArray(entry.centroid) ||
      entry.centroid.length !== 2 ||
      typeof entry.maxSampleRadiusMeters !== "number"
    ) {
      throw new Error(
        `--centroids file entry "${key}" is missing centroid/maxSampleRadiusMeters.`,
      );
    }
    out[key] = {
      centroid: [entry.centroid[0], entry.centroid[1]],
      maxSampleRadiusMeters: entry.maxSampleRadiusMeters,
    };
  }
  return out;
}

/**
 * Buckets one user, in the fixed priority order the task specifies:
 *
 *   1. deprecated_sub_area — stated city/town/subArea matches a known
 *      deprecated sub-area entry.
 *   2. unresolvable — a stated town that is absent from the registry for
 *      its city, checked against BOTH `towns` and `deprecatedTowns` (a
 *      deprecated town is still valid-as-stored, only unresolvable when
 *      truly absent from both).
 *   3. no_pin — no usable coordinate (see `parseUserCoordinates`).
 *   4. agree / disagree / no_centroid — the stated town has no centroid on
 *      record at all (no_centroid, the sixth bucket this script adds), or
 *      the pin sits within (agree) / beyond (disagree) the containment
 *      threshold of the town's centroid.
 *
 * `distanceCache`, when passed, memoizes the haversine distance per
 * (town key, rounded-to-3-decimals coordinate) pair — the task's "dedupe on
 * coordinates rounded to 3 decimals before any per-coordinate work"
 * constraint. Purely an optimization: omitting it changes no output.
 *
 * @returns {{ bucket: (typeof BUCKETS)[number]; distanceMeters: number | null; city: string; town: string }}
 */
function bucketUser(user, ctx, options = {}) {
  const city = (user?.city || "").trim();
  const town = (user?.town || "").trim();
  const subArea = (user?.subArea || "").trim();
  const key = city && town ? cityTownKey(city, town) : null;

  // 1. deprecated_sub_area
  if (key && subArea) {
    const deprecatedSet = ctx.deprecatedSubAreas[key];
    if (deprecatedSet && deprecatedSet.has(subArea)) {
      return { bucket: "deprecated_sub_area", distanceMeters: null, city, town };
    }
  }

  // 2. unresolvable
  if (town) {
    const cityEntry = ctx.citiesTowns[city];
    const validAsStored =
      !!cityEntry &&
      (cityEntry.towns.has(town) || cityEntry.deprecatedTowns.has(town));
    if (!validAsStored) {
      return { bucket: "unresolvable", distanceMeters: null, city, town };
    }
  }

  // 3. no_pin
  const coords = parseUserCoordinates(user);
  if (!coords) {
    return { bucket: "no_pin", distanceMeters: null, city, town };
  }

  // 4. agree / disagree / no_centroid
  const centroidEntry = key ? ctx.centroids[key] : undefined;
  if (!centroidEntry) {
    return { bucket: "no_centroid", distanceMeters: null, city, town };
  }

  const centroidPoint = {
    lat: centroidEntry.centroid[1],
    lng: centroidEntry.centroid[0],
  };

  let distanceMeters;
  const cacheKey = options.distanceCache
    ? `${key}|${roundCoordinate(coords.lng)},${roundCoordinate(coords.lat)}`
    : null;
  if (cacheKey && options.distanceCache.has(cacheKey)) {
    distanceMeters = options.distanceCache.get(cacheKey);
  } else {
    distanceMeters = Math.round(haversineMeters(coords, centroidPoint));
    if (cacheKey) options.distanceCache.set(cacheKey, distanceMeters);
  }

  const thresholdMeters = computeContainmentThresholdMeters(
    centroidEntry.maxSampleRadiusMeters,
    options.thresholdKm,
  );
  const bucket = distanceMeters <= thresholdMeters ? "agree" : "disagree";
  return { bucket, distanceMeters, city, town };
}

/**
 * The verbatim language-discipline statement carried into every report
 * header. Asserted on by the jest suite — see this file's header comment for
 * why the wording matters.
 */
const DISAGREE_LANGUAGE_DISCIPLINE =
  '"disagree" means only that the stored pin sits farther from the stated ' +
  "town's centroid than the chosen containment threshold. It is NOT a " +
  "determination that the user's address is wrong, and this count must " +
  "NEVER be reported as a geocoder error rate — this script makes no " +
  "geocoding call at all; bucketing is centroid-distance only, against the " +
  "registry's own surveyed centroids.";

/**
 * Builds the report header: run metadata, the threshold policy (marked
 * provisional per the task brief), the centroid-coverage gap (prominent when
 * the registry ships no centroids and no --centroids override was given),
 * and the language-discipline statement above.
 */
function buildReportHeader({
  target,
  dbName,
  thresholdKm,
  centroidsSource,
  totalCentroids,
}) {
  return {
    generatedAt: new Date().toISOString(),
    target,
    dbName,
    thresholdPolicy: {
      description:
        "PROVISIONAL heuristic: max(town's maxSampleRadiusMeters x 1.5, 2000m " +
        "floor), or a fixed --threshold-km override applied to every town. " +
        "maxSampleRadiusMeters is the spread of a hand-drawn P0.1a sampling " +
        "box, NOT a validated containment bound (see report.js's own " +
        "centroids.json caveat) — this threshold is a placeholder pending " +
        "the P0.1b boundary-derived figure.",
      multiplier: DEFAULT_THRESHOLD_MULTIPLIER,
      floorMeters: DEFAULT_THRESHOLD_FLOOR_METERS,
      overrideKm: typeof thresholdKm === "number" ? thresholdKm : null,
    },
    centroidCoverage: {
      source: centroidsSource,
      totalTownsWithCentroid: totalCentroids,
      gapWarning:
        totalCentroids === 0
          ? "No area centroids are on record (the committed registry artifact " +
            "ships AREA_CENTROIDS/CITY_CENTROIDS empty — the P0.1a sweep's " +
            "centroids.json by-product was searched for across both repos' " +
            "working trees and full git history and does not exist anywhere). " +
            "Every user who would otherwise be agree/disagree buckets as " +
            "no_centroid instead. Supply real coverage via --centroids " +
            "<path> once produced."
          : null,
    },
    languageDiscipline: DISAGREE_LANGUAGE_DISCIPLINE,
  };
}

module.exports = {
  BUCKETS,
  cityTownKey,
  roundCoordinate,
  parseUserCoordinates,
  haversineMeters,
  computeContainmentThresholdMeters,
  buildRegistryContext,
  loadCentroidsOverride,
  bucketUser,
  buildReportHeader,
  DISAGREE_LANGUAGE_DISCIPLINE,
  DEFAULT_THRESHOLD_MULTIPLIER,
  DEFAULT_THRESHOLD_FLOOR_METERS,
};

// ---------------------------------------------------------------------------
// Entrypoint — DB connection, cursoring, checkpointing. Kept out of jest
// (the task brief's own instruction): everything above this line is pure and
// unit-tested; everything below only runs from the CLI.
// ---------------------------------------------------------------------------

const OUT_DIR = path.join(__dirname, "out");

if (require.main === module) {
  main().catch((error) => {
    console.error("Audit failed:", error);
    process.exitCode = 1;
  });
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (arg.startsWith("--")) {
      args[arg.slice(2)] = true;
    }
  }
  return args;
}

function parseTarget(args) {
  const value = args.target;
  if (value !== "production" && value !== "test") {
    throw new Error(
      "--target=production|test is required. This script reads the entire " +
        "users collection, so the target is never inferred: pass " +
        "--target=test to run against MONGODB_URI_TEST, or " +
        "--target=production to run against MONGODB_URI.",
    );
  }
  return value;
}

// Mirrors scripts/backfill-referral-reward-granted.js's own guard exactly.
function assertDatabaseMatchesTarget(target, dbName) {
  const looksLikeTest = /(^|[-_])test([-_]|$)|^test_db$/i.test(dbName);

  if (target === "test" && !looksLikeTest) {
    throw new Error(
      `Refusing to run: --target=test but the connected database is ` +
        `"${dbName}", which does not look like a test database.`,
    );
  }
  if (target === "production" && looksLikeTest) {
    throw new Error(
      `Refusing to run: --target=production but the connected database is ` +
        `"${dbName}", which looks like a test database. Check MONGODB_URI.`,
    );
  }
}

function hashUserId(id) {
  return crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 16);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = parseTarget(args);

  const mongoUriKey = target === "production" ? "MONGODB_URI" : "MONGODB_URI_TEST";
  const mongoUri = process.env[mongoUriKey];
  if (!mongoUri) {
    throw new Error(`${mongoUriKey} is not set — required by --target=${target}.`);
  }

  const thresholdKm = args["threshold-km"] !== undefined ? Number(args["threshold-km"]) : undefined;
  if (thresholdKm !== undefined && !Number.isFinite(thresholdKm)) {
    throw new Error(`--threshold-km must be a number, got "${args["threshold-km"]}".`);
  }

  const overrideCentroids = args.centroids
    ? loadCentroidsOverride(path.resolve(process.cwd(), args.centroids))
    : undefined;

  const outPath = args.out
    ? path.resolve(process.cwd(), args.out)
    : path.join(OUT_DIR, "audit-report.json");
  const checkpointPath = args.checkpoint
    ? path.resolve(process.cwd(), args.checkpoint)
    : path.join(OUT_DIR, "audit-report.checkpoint.json");
  const ndjsonPath = `${outPath}.partial.ndjson`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  await mongoose.connect(mongoUri, { bufferCommands: false });
  const dbName = mongoose.connection.db.databaseName;

  try {
    assertDatabaseMatchesTarget(target, dbName);
  } catch (err) {
    await mongoose.disconnect();
    throw err;
  }

  console.log(`Target: ${target} (${mongoUriKey}) — database "${dbName}" [READ-ONLY]`);

  const ctx = buildRegistryContext(registryArtifact, overrideCentroids);
  const totalCentroids = Object.keys(ctx.centroids).length;

  // ---- resume support ----------------------------------------------------
  let lastId = null;
  let ndjsonMode = "w";
  if (fs.existsSync(checkpointPath)) {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    if (checkpoint.target === target && checkpoint.mongoUriKey === mongoUriKey) {
      lastId = checkpoint.lastId;
      ndjsonMode = "a";
      console.log(`Resuming from checkpoint after _id ${lastId}.`);
    } else {
      console.log("Checkpoint belongs to a different target — starting fresh.");
    }
  }

  const users = mongoose.connection.collection("users");

  // ---- P0.4b gate: migration existence check -----------------------------
  const pickupHistoryGate = await users.countDocuments({
    "pickupHistory.0": { $exists: true },
  });

  const query = {
    $or: [
      { "location.coordinates": { $exists: true } },
      { latitude: { $exists: true, $ne: "" } },
      { longitude: { $exists: true, $ne: "" } },
      { town: { $exists: true, $ne: "" } },
      { subArea: { $exists: true, $ne: "" } },
    ],
  };
  if (lastId) {
    query._id = { $gt: new mongoose.Types.ObjectId(lastId) };
  }

  const totalToScan = await users.countDocuments(query);
  console.log(`Users matching the audit filter (this run): ${totalToScan}`);

  const ndjsonStream = fs.createWriteStream(ndjsonPath, { flags: ndjsonMode });
  const distanceCache = new Map();
  const cursor = users
    .find(query, {
      projection: {
        _id: 1,
        city: 1,
        town: 1,
        subArea: 1,
        latitude: 1,
        longitude: 1,
        "location.coordinates": 1,
      },
    })
    .sort({ _id: 1 });

  let processed = 0;
  let cursorLastId = lastId;
  const CHECKPOINT_EVERY = 500;

  for await (const user of cursor) {
    const result = bucketUser(user, ctx, { thresholdKm, distanceCache });
    // Per the task brief: id hash (NOT email), bucket, distanceMeters, city,
    // town. `city`/`town` double as the P0.5 aggregation key below.
    const row = {
      idHash: hashUserId(user._id),
      bucket: result.bucket,
      distanceMeters: result.distanceMeters,
      city: result.city,
      town: result.town,
    };
    ndjsonStream.write(JSON.stringify(row) + "\n");

    cursorLastId = String(user._id);
    processed += 1;
    if (processed % CHECKPOINT_EVERY === 0) {
      fs.writeFileSync(
        checkpointPath,
        JSON.stringify({ target, mongoUriKey, lastId: cursorLastId, processed }),
      );
      console.log(`  ...checkpoint at ${processed} users (last _id ${cursorLastId})`);
    }
  }
  ndjsonStream.end();
  await new Promise((resolve) => ndjsonStream.on("finish", resolve));

  // ---- aggregate the full ndjson (all resumed segments included) --------
  const lines = fs
    .readFileSync(ndjsonPath, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const rows = lines.map((l) => JSON.parse(l));

  /** @type {Record<string, number>} */
  const byBucket = {};
  /** @type {Record<string, Record<string, number>>} bucket -> city -> count */
  const byBucketAndCity = {};
  /** @type {Record<string, number>} P0.5 — deprecated_sub_area rows grouped by City::Town */
  const p05ByEntry = {};

  for (const row of rows) {
    byBucket[row.bucket] = (byBucket[row.bucket] || 0) + 1;
    byBucketAndCity[row.bucket] = byBucketAndCity[row.bucket] || {};
    byBucketAndCity[row.bucket][row.city] = (byBucketAndCity[row.bucket][row.city] || 0) + 1;

    if (row.bucket === "deprecated_sub_area") {
      const key = cityTownKey(row.city, row.town);
      p05ByEntry[key] = (p05ByEntry[key] || 0) + 1;
    }
  }

  const report = {
    header: buildReportHeader({
      target,
      dbName,
      thresholdKm,
      centroidsSource: overrideCentroids ? args.centroids : "registry artifact (lib/data/locationRegistry.json)",
      totalCentroids,
    }),
    counts: {
      totalUsersScanned: rows.length,
      byBucket,
      byBucketAndCity,
    },
    p0_5_deprecatedSubAreaByEntry: p05ByEntry,
    p0_4b_pickupHistoryGate: pickupHistoryGate,
    users: rows,
  };

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  fs.rmSync(ndjsonPath, { force: true });
  fs.rmSync(checkpointPath, { force: true });

  // ---- printed summary -----------------------------------------------
  console.log("\n=== Location Backfill Audit — Summary ===");
  console.log(`Total users scanned (this + resumed segments): ${rows.length}`);
  console.log("\nBucket counts:");
  for (const bucket of BUCKETS) {
    console.log(`  ${bucket.padEnd(20)} ${byBucket[bucket] || 0}`);
  }

  console.log("\nBucket x City table:");
  for (const bucket of BUCKETS) {
    const cityCounts = byBucketAndCity[bucket] || {};
    const cities = Object.keys(cityCounts).sort();
    if (cities.length === 0) continue;
    console.log(`  ${bucket}:`);
    for (const city of cities) {
      console.log(`    ${(city || "(no city)").padEnd(24)} ${cityCounts[city]}`);
    }
  }

  console.log("\nP0.5 — deprecated sub-area entries (sign-off evidence):");
  const p05Keys = Object.keys(p05ByEntry).sort();
  if (p05Keys.length === 0) {
    console.log("  (none)");
  } else {
    for (const key of p05Keys) {
      console.log(`  ${key.padEnd(32)} ${p05ByEntry[key]}`);
    }
  }

  console.log(`\nP0.4b — users with pickupHistory (migration-exists gate): ${pickupHistoryGate}`);

  if (report.header.centroidCoverage.gapWarning) {
    console.log(`\nWARNING: ${report.header.centroidCoverage.gapWarning}`);
  }

  console.log(`\nFull report written to: ${outPath}`);

  await mongoose.disconnect();
}
