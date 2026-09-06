// The single definition of what the Mongo -> Postgres dual-write mirrors.
//
// Plain CommonJS JavaScript on purpose, so all three consumers can read the
// same file: lib/dualWrite.ts imports it to decide what to write (allowJs),
// scripts/reconcile-mongo-postgres.mjs imports it to decide what to check
// (Node resolves the named exports through cjs-module-lexer), and ts-jest
// loads it directly. If those two lists could drift, the reconciler would either report
// clean on a table nobody mirrors (false confidence) or fail forever on one
// nobody was ever going to write (noise). One list, both jobs.

/** Mongo collection -> the Postgres table mirroring it 1:1 on `_id`. */
const MIRRORED = {
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
 * One-to-one child tables built from a parent document's sub-objects.
 *
 * Everything else is derived: a column's Mongo field is `camelCase(column)` on
 * the document root, and the column list itself comes from information_schema.
 * A hand-written map of the flat columns would drift from the ETL's; these
 * nested ones cannot be derived, so they are spelled out.
 */
const NESTED_CHILDREN = {
  user_locations: {
    collection: "users",
    key: "user_id",
    // The row exists iff the user has real location data.
    //
    // Testing `d.location` for existence does NOT work: UserSchema declares
    // `location.type` with `default: "Point"`, so Mongoose materialises
    // `{ type: "Point" }` on every user who has never dropped a pin. That is
    // the same quirk that makes a plain 2dsphere index unbuildable on this
    // collection, and here it would have given all ~7,269 users an otherwise
    // empty child row. So look for a value, not for the container.
    present: (d) =>
      hasValue(d.location, ["type"]) ||
      hasValue(d.structuredAddress) ||
      hasValue(d.locationVerification) ||
      Boolean(d.locationCompletedAt) ||
      (d.locationVersion ?? 0) > 0,
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

/**
 * Credentials ARE mirrored, deliberately.
 *
 * The instinct is to hold password hashes back — a second copy widens the
 * blast radius of a leak. It is the wrong call here. The ETL already copies
 * them, and Postgres becomes the authentication store at the end of the
 * window; a user who signed up or changed their password mid-window would
 * arrive at cutover with no usable hash and simply be unable to log in.
 * Excluding the column would also exclude it from reconciliation, so that
 * loss would be invisible until switchover day.
 *
 * What genuinely is not mirrored is `user_otp_flows` — see the migration
 * plan. An OTP in flight at cutover is worth a "request a new code", not a
 * dual-write path.
 */
const SECRET_COLUMNS = new Set();

/** True when an object carries at least one field worth recording. */
function hasValue(obj, ignore = []) {
  if (!obj || typeof obj !== "object") return false;
  return Object.entries(obj).some(([k, v]) => {
    if (ignore.includes(k)) return false;
    if (v === undefined || v === null || v === "") return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return hasValue(v);
    return true;
  });
}

/** `total_waste_collected` -> `totalWasteCollected`. */
function camelCase(column) {
  return column.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

module.exports = { MIRRORED, NESTED_CHILDREN, SECRET_COLUMNS, camelCase, hasValue };
