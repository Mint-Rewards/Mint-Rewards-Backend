import mongoose, { Schema, type Model } from "mongoose";

/**
 * Permanent cache for POST /api/location/reverse-geocode (P1.1).
 *
 * Co-located model + key-builder in its own module rather than lib/models.ts,
 * mirroring lib/rateLimit.ts: this is infrastructure state for exactly one
 * route, not a domain document other modules read, so it does not belong
 * alongside Brand/Campaign/User etc. Unlike RateLimitModel, this collection
 * carries NO TTL index — see the comment on the schema below for why that is
 * load-bearing rather than an oversight.
 */

export interface GeocodeCacheDocument extends mongoose.Document<string> {
  _id: string;
  /** LocationIQ's `address` object verbatim, as returned on the call that populated this entry. */
  raw: Record<string, unknown>;
  cityName: string | null;
  areaName: string | null;
  blockHint: string | null;
  resolvedAt: Date;
}

const GeocodeCacheSchema = new Schema<GeocodeCacheDocument>(
  {
    _id: { type: String, required: true },
    raw: { type: Schema.Types.Mixed, required: true },
    cityName: { type: String, default: null },
    areaName: { type: String, default: null },
    blockHint: { type: String, default: null },
    resolvedAt: { type: Date, required: true },
  },
  { versionKey: false },
);

// PERMANENT BY DESIGN — no TTL index, unlike RateLimitSchema next door.
// LocationIQ's free tier is billed per live *request*, not per cache size, so
// a ~100m-cell cache entry that never expires is what keeps repeat lookups
// (the same handful of pickup/delivery points requested over and over) inside
// that free tier for good, rather than re-billing them every time a TTL would
// evict and re-fetch. It also feeds `geocodedAreaRaw` on the User schema and
// the future gazetteer/alias-backlog work, both of which want the FIRST
// answer LocationIQ ever gave for a cell to stay available indefinitely, not
// just for a rolling window. Do not add an expireAfterSeconds index here
// without re-reading this comment and the P1.1 task brief.
const GeocodeCacheModel =
  (mongoose.models.GeocodeCache as Model<GeocodeCacheDocument>) ||
  mongoose.model<GeocodeCacheDocument>(
    "GeocodeCache",
    GeocodeCacheSchema,
    "geocodeCache",
  );

export default GeocodeCacheModel;

/**
 * Cache key for a coordinate pair: both values truncated to 3 decimal places
 * (~100m at Karachi's latitude) via `toFixed(3)`, per the P1.1 brief. Two
 * requests that round to the same cell always share one cache entry.
 */
export function geocodeCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}
