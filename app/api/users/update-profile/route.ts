import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { UserModel } from "@/lib/models";
import { awardProfileBonusIfEligible } from "@/lib/profileBonus";
import { awardReferralIfApplicable } from "@/lib/referrals";

export async function PUT(req: Request) {
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

    const body = await req.json();
    const {
      userName,
      phone,
      address,
      latitude,
      longitude,
      province,
      city,
      town,
      townOther,
      subArea,
      subAreaOther,
      firstTimeLogin,
      // Structured location (P0.3). NOTE: this destructure is one of TWO
      // allowlists a field must appear in — the `if (x !== undefined)` chain
      // below is the other. A field added to the schema but missing from
      // either one is dropped silently and the endpoint still returns 200 with
      // the unchanged value, which is indistinguishable from a successful
      // no-op write. Add to both, always.
      location,
      structuredAddress,
      locationVerification,
    } = body;

    const updateData: Record<string, unknown> = {};

    if (latitude !== undefined) updateData.latitude = latitude;
    if (longitude !== undefined) updateData.longitude = longitude;
    if (userName !== undefined) updateData.userName = userName;
    if (phone !== undefined) updateData.phone = phone;
    if (address !== undefined) updateData.address = address;
    if (province !== undefined) updateData.province = province;
    if (city !== undefined) updateData.city = city;
    if (town !== undefined) updateData.town = town;
    if (townOther !== undefined) updateData.townOther = townOther;
    if (subArea !== undefined) updateData.subArea = subArea;
    if (subAreaOther !== undefined) updateData.subAreaOther = subAreaOther;
    if (firstTimeLogin !== undefined)
      updateData.firstTimeLogin = firstTimeLogin;

    // ---- Structured location (P0.3) --------------------------------------
    // Written as DOTTED PATHS, never as whole sub-objects. Assigning
    // `updateData.location = {...}` would replace the entire subdocument, so a
    // partial update that omits `capturedAt` would silently erase it.
    assignNested(updateData, "structuredAddress", structuredAddress, [
      "cityId",
      "areaId",
      "blockId",
      "areaOther",
      "blockOther",
      "houseNo",
      "streetOrBlock",
    ]);

    assignNested(updateData, "locationVerification", locationVerification, [
      "status",
      "method",
      "geocodedAreaRaw",
      "geocodedAreaId",
      "selectedAreaId",
      "distanceMeters",
      "checkedAt",
      "resolvedBy",
    ]);

    const point = toGeoPoint(location);
    if (point) {
      updateData["location.type"] = "Point";
      updateData["location.coordinates"] = point.coordinates;
      if (location.source !== undefined) {
        updateData["location.source"] = location.source;
      }
      if (location.precision !== undefined) {
        updateData["location.precision"] = location.precision;
      }
      if (location.accuracyMeters !== undefined) {
        updateData["location.accuracyMeters"] = location.accuracyMeters;
      }
      updateData["location.capturedAt"] = location.capturedAt ?? new Date();

      // Dual-write NEW -> LEGACY, so readers that still use the string pair
      // keep working. Only when the caller did not send the legacy fields
      // itself, so an explicit value always wins.
      //
      // The reverse direction is deliberately NOT done: a legacy string has no
      // known source or precision, and synthesising them here would fabricate
      // provenance for a coordinate whose origin is exactly what the backfill
      // exists to determine.
      const [lng, lat] = point.coordinates;
      if (latitude === undefined) updateData.latitude = String(lat);
      if (longitude === undefined) updateData.longitude = String(lng);
    }

    const updatedUser = await UserModel.findByIdAndUpdate(userId, updateData, {
      new: true,
    }).select("-password");

    if (!updatedUser) {
      return Response.json(
        { message: "User profile not found." },
        { status: 404 },
      );
    }

    if (updatedUser.phone && updatedUser.address) {
      await awardReferralIfApplicable(updatedUser._id, updatedUser.email);
    }

    // Unconditional, unlike the referral payout above: this helper re-reads the
    // user and judges completeness itself (against evaluateLocation, which is
    // strictly stricter than `phone && address`), so gating it on a looser
    // predicate here could only ever produce false negatives. It is also called
    // from PATCH /api/users/location, because the client fires both requests in
    // sequence and either can be the one that closes the last gap — the grant
    // is idempotent by construction, so calling it twice pays once.
    await awardProfileBonusIfEligible(updatedUser._id);

    return Response.json(updatedUser);
  } catch {
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}

/**
 * Copies an allowlisted subset of `source` onto `target` as dotted paths
 * (`prefix.key`), so a partial update never replaces the whole subdocument.
 *
 * Unknown keys are ignored rather than rejected, matching how the scalar
 * allowlist above already behaves.
 */
function assignNested(
  target: Record<string, unknown>,
  prefix: string,
  source: unknown,
  allowed: readonly string[],
): void {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return;
  }
  const record = source as Record<string, unknown>;
  for (const key of allowed) {
    if (record[key] !== undefined) target[`${prefix}.${key}`] = record[key];
  }
}

/**
 * Builds a GeoJSON point from a request body's `location`, or null when the
 * coordinates are absent or unusable.
 *
 * Returning null rather than throwing keeps a malformed pin from failing the
 * whole profile save — the rest of the update still lands, and the user is not
 * blocked from completing onboarding by a bad coordinate.
 *
 * Coordinates are emitted [lng, lat]: GeoJSON order, the reverse of how the
 * legacy `latitude`/`longitude` pair reads. Writing NaN here would make the
 * document unindexable once the 2dsphere index exists, so both values are
 * range-checked, not merely parsed.
 */
function toGeoPoint(
  location: unknown,
): { coordinates: [number, number] } | null {
  if (typeof location !== "object" || location === null) return null;
  const { lat, lng } = location as Record<string, unknown>;

  const latitude = typeof lat === "string" ? Number.parseFloat(lat) : lat;
  const longitude = typeof lng === "string" ? Number.parseFloat(lng) : lng;

  if (typeof latitude !== "number" || !Number.isFinite(latitude)) return null;
  if (typeof longitude !== "number" || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  return { coordinates: [longitude, latitude] };
}
