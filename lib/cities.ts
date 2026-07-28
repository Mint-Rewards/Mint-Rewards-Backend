// Fixed city list for campaign location targeting. Any change here is a
// product decision (which cities Mint Rewards operates in), not a code
// change elsewhere — every validation/filter path reads from this list.
export const TARGETABLE_CITIES = [
  "Karachi",
  "Lahore",
  "Islamabad",
  "Faisalabad",
  "Rawalpindi",
  "Multan",
  "Hyderabad",
] as const;

export type TargetableCity = (typeof TARGETABLE_CITIES)[number];

export class InvalidCityError extends Error {
  invalidValues: string[];

  constructor(invalidValues: string[]) {
    super(`Invalid cities: ${invalidValues.join(", ")}`);
    this.name = "InvalidCityError";
    this.invalidValues = invalidValues;
  }
}

function isTargetableCity(value: string): value is TargetableCity {
  return (TARGETABLE_CITIES as readonly string[]).includes(value);
}

/**
 * Parses a `cities` value from a campaign create/update request body.
 * Accepts a JSON array of strings, or a comma-separated string (request
 * bodies sent as multipart/form-data — required when a banner file is
 * attached — carry every field as a string). Returns [] for
 * undefined/null/empty input, meaning "untargeted".
 *
 * Throws InvalidCityError if any value isn't one of TARGETABLE_CITIES.
 */
export function parseTargetCities(raw: unknown): TargetableCity[] {
  if (raw === undefined || raw === null || raw === "") return [];

  const values: string[] = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : typeof raw === "string"
      ? raw.split(",")
      : [];

  const trimmed = values.map((v) => v.trim()).filter((v) => v.length > 0);
  const deduped = Array.from(new Set(trimmed));

  const invalid = deduped.filter((v) => !isTargetableCity(v));
  if (invalid.length > 0) {
    throw new InvalidCityError(invalid);
  }

  return deduped as TargetableCity[];
}
