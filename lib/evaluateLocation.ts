/**
 * Server-side single source of location-completion truth. The client
 * contains no completion logic of its own — every surface (profile gating,
 * pickup eligibility, admin views) calls this to learn whether a user's
 * location is "done" and, if not, what is missing.
 *
 * The requirement SET varies by the resolved city's registry coverage (Task
 * 1's `lib/locationRegistry.ts`): a Tier A/B city with a defined towns list
 * can demand a selected area; anything else (Tier C, an unlisted city, or no
 * city at all) falls back to requiring a map pin instead, because there is no
 * registry-backed area list to choose from. This is the "escape hatch" rule —
 * a hard gate must never demand a value the registry cannot offer.
 */

import { cityHasTowns, getCoverageTier } from "@/lib/locationRegistry";
import type { User } from "@/lib/types";

export const LOCATION_COMPLETION_VERSION = 1;

export type LocationRequirementField = "cityId" | "areaId" | "houseNo" | "pin";

export interface LocationEvaluation {
  complete: boolean;
  /** Subset of ["cityId","areaId","houseNo","pin"], in that fixed order. */
  missing: LocationRequirementField[];
  version: number;
  currentVersion: number;
  bucket: "complete" | "has_pin_partial" | "no_pin";
}

/**
 * Everything `evaluateLocation` reads off a user. `Partial<Pick<User, ...>>`
 * rather than the full `User` so a plain object built in a test — or a
 * Mongoose document missing fields it never set — both satisfy the type
 * without a cast.
 */
export type EvaluableUser = Partial<
  Pick<
    User,
    "city" | "town" | "townOther" | "structuredAddress" | "location" | "locationVersion"
  >
>;

/** "Non-empty" means non-empty after trim, everywhere in this module. */
function nonEmpty(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The city used both to satisfy the `cityId` field and to look up the
 * registry tier: `structuredAddress.cityId` if non-empty, else the legacy
 * `city` string if non-empty, else undefined.
 */
function resolveCity(user: EvaluableUser): string | undefined {
  if (nonEmpty(user.structuredAddress?.cityId)) return user.structuredAddress!.cityId;
  if (nonEmpty(user.city)) return user.city;
  return undefined;
}

function hasAreaId(user: EvaluableUser): boolean {
  if (nonEmpty(user.structuredAddress?.areaId)) return true;
  if (nonEmpty(user.structuredAddress?.areaOther)) return true;
  if (nonEmpty(user.town)) return true;
  if (nonEmpty(user.townOther)) return true;
  return false;
}

function hasHouseNo(user: EvaluableUser): boolean {
  return nonEmpty(user.structuredAddress?.houseNo);
}

/**
 * A pin counts only when it is a usable, human/collector-placed point: a
 * 2-length array of finite numbers, captured with a `source` of `"map_pin"`
 * or `"collector_verified"` — NOT a centroid fallback (`"area_centroid"`,
 * `"city_centroid"`) and NOT a bare/legacy string coordinate.
 */
function hasPin(user: EvaluableUser): boolean {
  const coordinates = user.location?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return false;
  if (!coordinates.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return false;
  }
  const source = user.location?.source;
  return source === "map_pin" || source === "collector_verified";
}

/**
 * The ordered list of fields this user must satisfy to be "complete":
 *
 * - Tier A/B AND the resolved city has a defined towns list:
 *   `["cityId","areaId","houseNo"]` — no pin demanded, an area selection is
 *   available and preferred.
 * - Tier C, a city without towns, or no city at all: `["cityId","houseNo","pin"]`
 *   — no area list to select from, so a pin is required instead. `getCoverageTier`
 *   and `cityHasTowns` both default safely (tier "C", no towns) for an unknown
 *   or absent city, so "no city at all" falls out of the same branch with no
 *   special case needed.
 */
function requiredFields(city: string | undefined): LocationRequirementField[] {
  const lookupCity = city ?? "";
  const tier = getCoverageTier(lookupCity);
  const hasTowns = cityHasTowns(lookupCity);
  const areaSelectable = (tier === "A" || tier === "B") && hasTowns;

  return areaSelectable ? ["cityId", "areaId", "houseNo"] : ["cityId", "houseNo", "pin"];
}

export function evaluateLocation(user: EvaluableUser): LocationEvaluation {
  const city = resolveCity(user);

  const satisfied: Record<LocationRequirementField, boolean> = {
    cityId: city !== undefined,
    areaId: hasAreaId(user),
    houseNo: hasHouseNo(user),
    pin: hasPin(user),
  };

  const required = requiredFields(city);
  const missing = required.filter((field) => !satisfied[field]);
  const complete = missing.length === 0;

  const bucket: LocationEvaluation["bucket"] = complete
    ? "complete"
    : satisfied.pin
      ? "has_pin_partial"
      : "no_pin";

  return {
    complete,
    missing,
    version: LOCATION_COMPLETION_VERSION,
    currentVersion: user.locationVersion ?? 0,
    bucket,
  };
}
