import type { User, PickupAddressSnapshot } from "@/lib/types";

/**
 * P0.4a — build the address snapshot written onto a pickup record at creation.
 *
 * `pickupHistory` entries must never reference the live User document for
 * address data: a later profile edit would silently re-point every historical
 * pickup, and re-pointed pickups cannot be un-re-pointed. EVERY code path that
 * creates a pickup entry must call this and store the result on
 * `addressSnapshot`. (No such path exists in this repo yet — the writer lives
 * in the collector system; this is the contract it must use.)
 *
 * Coordinate rules mirror the P0.3 dual-write discipline: never emit NaN or an
 * empty coordinates array. Prefer the structured GeoJSON `location`; fall back
 * to the legacy latitude/longitude strings only when they parse, tagged
 * `legacy_string`/`unknown`; otherwise omit `location` entirely.
 */
export function buildPickupAddressSnapshot(
  user: Pick<
    User,
    | "address"
    | "province"
    | "city"
    | "town"
    | "townOther"
    | "subArea"
    | "subAreaOther"
    | "latitude"
    | "longitude"
  > &
    Partial<Pick<User, "structuredAddress" | "location">>,
): PickupAddressSnapshot {
  const snapshot: PickupAddressSnapshot = {
    address: user.address ?? "",
    province: user.province ?? "",
    city: user.city ?? "",
    town: user.town ?? "",
    townOther: user.townOther ?? "",
    subArea: user.subArea ?? "",
    subAreaOther: user.subAreaOther ?? "",
    snapshotSource: "creation",
    snapshotAt: new Date(),
  };

  if (user.structuredAddress) {
    snapshot.structuredAddress = { ...user.structuredAddress };
  }

  const coords = user.location?.coordinates;
  if (
    coords &&
    coords.length === 2 &&
    coords.every((c) => Number.isFinite(c))
  ) {
    snapshot.location = { ...user.location, coordinates: [...coords] };
  } else {
    const lat = parseFloat(user.latitude ?? "");
    const lng = parseFloat(user.longitude ?? "");
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      snapshot.location = {
        type: "Point",
        // [lng, lat] — GeoJSON order.
        coordinates: [lng, lat],
        source: "legacy_string",
        precision: "unknown",
      };
    }
  }

  return snapshot;
}
