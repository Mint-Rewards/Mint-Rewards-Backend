import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { UserModel } from "@/lib/models";
import {
  evaluateLocation,
  LOCATION_COMPLETION_VERSION,
} from "@/lib/evaluateLocation";
import { getProvinceForCity } from "@/lib/locationRegistry";
import type { LocationPrecision, LocationSource } from "@/lib/types";

const MAX_STRING_LENGTH = 200;

// Mirrors the enums on UserSchema.location (lib/models.ts) — kept in sync by
// hand since Mongoose does not expose its schema enums as a reusable const.
const LOCATION_SOURCES: ReadonlySet<LocationSource> = new Set([
  "map_pin",
  "area_centroid",
  "city_centroid",
  "legacy_string",
  "collector_verified",
]);

const LOCATION_PRECISIONS: ReadonlySet<LocationPrecision> = new Set([
  "building",
  "block",
  "area",
  "city",
  "unknown",
]);

// Every structuredAddress leaf this endpoint accepts, in the order they are
// applied. Order matters only for the (unspecified, edge-case) situation
// where a single request sends both members of a canonical/"Other" pair —
// see applyStructuredAddress.
const STRUCTURED_ADDRESS_FIELDS = [
  "cityId",
  "areaId",
  "blockId",
  "areaOther",
  "blockOther",
  "houseNo",
  "streetOrBlock",
] as const;

type StructuredAddressField = (typeof STRUCTURED_ADDRESS_FIELDS)[number];

/**
 * Progressive-save endpoint (P1.4): accepts any subset of `structuredAddress`
 * and `location` and writes only the provided leaves as DOTTED `$set` paths —
 * never a whole-subdocument assign, which would wipe sibling keys a prior
 * partial save already wrote (the P0.3 lesson, see update-profile/route.ts).
 *
 * Legacy string fields (`city`, `province`, `town`, `townOther`, `subArea`,
 * `subAreaOther`, `latitude`, `longitude`) are dual-written in the same
 * `$set` so readers that have not migrated to the structured fields keep
 * working.
 */
export async function PATCH(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: {
        authorization: req.headers.get("authorization") ?? undefined,
      },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const { structuredAddress, location } =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    const setFields: Record<string, unknown> = {};

    const structuredAddressError = applyStructuredAddress(
      setFields,
      structuredAddress,
    );
    const locationError = structuredAddressError
      ? null
      : applyLocation(setFields, location);
    const validationError = structuredAddressError ?? locationError;

    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 });
    }

    const hasUpdate = Object.keys(setFields).length > 0;
    const user = hasUpdate
      ? await UserModel.findByIdAndUpdate(
          userId,
          { $set: setFields },
          { new: true },
        )
      : await UserModel.findById(userId);

    if (!user) {
      return Response.json(
        { message: "User profile not found." },
        { status: 404 },
      );
    }

    const evaluation = evaluateLocation(user);

    // Version bump happens exactly once: only when the requirement set is
    // newly satisfied AND the user has not already been marked complete at
    // this (or a later) version. A repeat PATCH after completion leaves
    // locationCompletedAt untouched.
    if (
      evaluation.complete &&
      (user.locationVersion ?? 0) < LOCATION_COMPLETION_VERSION
    ) {
      await UserModel.updateOne(
        { _id: userId },
        {
          $set: {
            locationVersion: LOCATION_COMPLETION_VERSION,
            locationCompletedAt: new Date(),
          },
        },
      );
    }

    return Response.json({ Status: "Success", evaluation });
  } catch {
    return Response.json(
      { error: "Your request could not be processed. Please try again." },
      { status: 500 },
    );
  }
}

/** Trims a string leaf and enforces the 200-char cap; returns an error message on failure. */
function validateStringLeaf(
  value: unknown,
  field: string,
): { value: string } | { error: string } {
  if (typeof value !== "string") {
    return { error: `${field} must be a string.` };
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_STRING_LENGTH) {
    return {
      error: `${field} must be at most ${MAX_STRING_LENGTH} characters.`,
    };
  }
  return { value: trimmed };
}

/**
 * Applies the allowlisted `structuredAddress` leaves present in the request
 * onto `setFields` as `structuredAddress.<key>` dotted paths, dual-writing
 * the corresponding legacy field(s) per the P1.4 table. Unknown keys are
 * ignored. Returns an error message (and leaves `setFields` partially
 * populated but never persisted, since the caller checks for an error before
 * writing) on the first invalid leaf.
 */
function applyStructuredAddress(
  setFields: Record<string, unknown>,
  structuredAddress: unknown,
): string | null {
  if (structuredAddress === undefined) return null;
  if (
    typeof structuredAddress !== "object" ||
    structuredAddress === null ||
    Array.isArray(structuredAddress)
  ) {
    return "structuredAddress must be an object.";
  }

  const record = structuredAddress as Record<string, unknown>;

  for (const field of STRUCTURED_ADDRESS_FIELDS) {
    if (record[field] === undefined) continue;

    const result = validateStringLeaf(
      record[field],
      `structuredAddress.${field}`,
    );
    if ("error" in result) return result.error;

    setFields[`structuredAddress.${field}`] = result.value;
    dualWriteLegacyAddressField(setFields, field, result.value);
  }

  return null;
}

function dualWriteLegacyAddressField(
  setFields: Record<string, unknown>,
  field: StructuredAddressField,
  value: string,
): void {
  switch (field) {
    case "cityId": {
      setFields.city = value;
      const province = getProvinceForCity(value);
      if (province !== null) setFields.province = province;
      break;
    }
    case "areaId": {
      setFields.town = value;
      setFields.townOther = "";
      break;
    }
    case "areaOther": {
      setFields.townOther = value;
      setFields.town = "";
      break;
    }
    case "blockId": {
      setFields.subArea = value;
      setFields.subAreaOther = "";
      break;
    }
    case "blockOther": {
      setFields.subAreaOther = value;
      setFields.subArea = "";
      break;
    }
    default:
      break;
  }
}

/**
 * Applies the allowlisted `location` leaves present in the request onto
 * `setFields`. `coordinates`, `source`, `precision` and `accuracyMeters` are
 * each independently optional (a progressive save may send any subset).
 * Writing `coordinates` also sets `location.type` and `location.capturedAt`,
 * and dual-writes the legacy `latitude`/`longitude` strings.
 */
function applyLocation(
  setFields: Record<string, unknown>,
  location: unknown,
): string | null {
  if (location === undefined) return null;
  if (
    typeof location !== "object" ||
    location === null ||
    Array.isArray(location)
  ) {
    return "location must be an object.";
  }

  const record = location as Record<string, unknown>;

  if (record.coordinates !== undefined) {
    const coordinates = record.coordinates;
    if (
      !Array.isArray(coordinates) ||
      coordinates.length !== 2 ||
      !coordinates.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    ) {
      return "location.coordinates must be a [lng, lat] pair of finite numbers.";
    }

    const [lng, lat] = coordinates as [number, number];
    if (lng < -180 || lng > 180) {
      return "location.coordinates longitude must be between -180 and 180.";
    }
    if (lat < -90 || lat > 90) {
      return "location.coordinates latitude must be between -90 and 90.";
    }

    setFields["location.coordinates"] = [lng, lat];
    setFields["location.type"] = "Point";
    setFields["location.capturedAt"] = new Date();

    // Legacy pair reads lat/lng human order — the reverse of GeoJSON.
    setFields.latitude = String(lat);
    setFields.longitude = String(lng);
  }

  if (record.source !== undefined) {
    if (
      typeof record.source !== "string" ||
      !LOCATION_SOURCES.has(record.source as LocationSource)
    ) {
      return "location.source is not a recognized value.";
    }
    setFields["location.source"] = record.source;
  }

  if (record.precision !== undefined) {
    if (
      typeof record.precision !== "string" ||
      !LOCATION_PRECISIONS.has(record.precision as LocationPrecision)
    ) {
      return "location.precision is not a recognized value.";
    }
    setFields["location.precision"] = record.precision;
  }

  if (record.accuracyMeters !== undefined) {
    if (
      typeof record.accuracyMeters !== "number" ||
      !Number.isFinite(record.accuracyMeters)
    ) {
      return "location.accuracyMeters must be a finite number.";
    }
    setFields["location.accuracyMeters"] = record.accuracyMeters;
  }

  return null;
}
