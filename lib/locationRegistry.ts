/**
 * Backend registry knowledge — cities, towns, tiers, aliases — for the
 * location-capture project.
 *
 * The backend has no registry source of truth of its own. This module reads
 * a committed JSON export (`lib/data/locationRegistry.json`) of the app
 * repo's `utils/pakistan_areas.ts` / `pakistan_locations.ts`, produced by
 * that repo's `scripts/export_location_registry.ts`
 * (`npm run export:registry`). The PC-2 pattern: staleness is visible — the
 * two repos can only diverge if someone edits the app registry and forgets
 * to re-run and re-commit the export — rather than a live cross-repo fetch
 * that could fail silently in production.
 *
 * `foldName` and `resolveGeocodedName`'s resolution order (coarse-admin-unit
 * guard, then exact, then folded, then alias, with deprecated-town handling)
 * mirror the app's own `utils/pakistan_areas.ts`. See each function's doc
 * comment for exactly what is, and is not, reproduced here — notably, the
 * app's affix-tolerant pass ("Town" suffix / Islamabad "Sector" prefix
 * stripping) is NOT reproduced, because that data is not present in the
 * committed artifact. (The `COARSE_ADMIN_UNITS` guard WAS missing in the
 * first cut of this module and was added in a fix round — see
 * `coarseAdminUnits` on `CityEntry` below.)
 */

import registryData from "@/lib/data/locationRegistry.json";

export type CoverageTier = "A" | "B" | "C";

interface CityEntry {
  province: string;
  tier: CoverageTier;
  hasTowns: boolean;
  towns: string[];
  selectableTowns: string[];
  deprecatedTowns: string[];
  /** Alias string -> canonical town, inverted from the app's `AREA_META`. */
  aliases: Record<string, string>;
  /**
   * Already-folded strings (the artifact stores these pre-folded, mirroring
   * the app's own `COARSE_ADMIN_UNITS`) naming administrative parents in this
   * city — e.g. "Gulberg Town" in Karachi, which spans many registered
   * areas. See `resolveGeocodedName` for how this is used.
   */
  coarseAdminUnits: string[];
}

interface RegistryData {
  version: number;
  cities: Record<string, CityEntry>;
}

const registry = registryData as RegistryData;

function normalizeKey(value: string | undefined | null): string {
  return (value || "").trim();
}

function getCityEntry(city: string): CityEntry | undefined {
  return registry.cities[normalizeKey(city)];
}

/** The province a city belongs to, or null when the city is not in the registry. */
export function getProvinceForCity(city: string): string | null {
  return getCityEntry(city)?.province ?? null;
}

/**
 * Operational coverage tier for a city. Defaults to "C" (no known coverage)
 * for a city absent from the registry — mirrors the app's `getCoverageTier`.
 */
export function getCoverageTier(city: string): CoverageTier {
  return getCityEntry(city)?.tier ?? "C";
}

/** True only for cities that have a defined towns list. Defaults to false. */
export function cityHasTowns(city: string): boolean {
  return getCityEntry(city)?.hasTowns ?? false;
}

/**
 * Folds a name to a comparable form: lowercased, punctuation and spacing
 * removed. Ported VERBATIM from the app repo's `foldName`
 * (utils/pakistan_areas.ts:103). Do not "improve" this independently of that
 * copy — the two repos folding names differently would make an area the app
 * resolves fail to resolve here, or vice versa.
 */
export function foldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Per-city lookup used by `resolveGeocodedName`, built once per city on
 * first use and cached: canonical towns keyed by their folded form, alias
 * strings keyed by their folded form, and the set of deprecated town names.
 */
interface CityIndex {
  townByFold: Map<string, string>; // foldedTownName -> canonical town
  aliasByFold: Map<string, string>; // foldedAlias -> canonical town
  deprecated: Set<string>; // canonical town names hidden from new selections
  coarseAdminUnits: Set<string>; // already-folded administrative-parent strings
}

const cityIndexCache = new Map<string, CityIndex | null>();

function getCityIndex(city: string): CityIndex | null {
  const key = normalizeKey(city);
  const cached = cityIndexCache.get(key);
  if (cached !== undefined) return cached;

  const entry = registry.cities[key];
  if (!entry) {
    cityIndexCache.set(key, null);
    return null;
  }

  const townByFold = new Map<string, string>();
  for (const town of entry.towns) townByFold.set(foldName(town), town);

  const aliasByFold = new Map<string, string>();
  for (const [alias, town] of Object.entries(entry.aliases)) {
    aliasByFold.set(foldName(alias), town);
  }

  const index: CityIndex = {
    townByFold,
    aliasByFold,
    deprecated: new Set(entry.deprecatedTowns),
    // Members are already folded (see the CityEntry doc comment), so a
    // lookup here compares directly against `foldName(raw)` with no extra
    // folding step.
    coarseAdminUnits: new Set(entry.coarseAdminUnits),
  };
  cityIndexCache.set(key, index);
  return index;
}

export interface ResolvedLocation {
  city: string;
  town: string;
}

/**
 * Resolves a raw geocoder locality to a canonical `{ city, town }`, or null
 * on a miss. Mirrors the app's `resolveGeocodedName`
 * (utils/pakistan_areas.ts): a coarse-admin-unit guard runs first, then
 * resolution order is exact match, then folded match, then alias match — all
 * compared via `foldName`, since an exact string match is always also a
 * folded match. A folded query that matches nothing (or matches ambiguously)
 * is a miss, never a guess.
 *
 * COARSE-ADMIN-UNIT GUARD (runs before any matching, only when `city` is
 * given): an administrative parent — e.g. "Gulberg Town" in Karachi, which
 * spans many registered areas, or "Bin Qasim Town", "Jamshed Town",
 * "S.I.T.E. Town" — has no single right answer, so every available answer is
 * wrong for most of its residents. A raw string whose `foldName(...)` is in
 * that city's `coarseAdminUnits` refuses before matching even starts,
 * mirroring the app's `isCoarseAdminUnit` check and its position (before
 * exact/fold/alias) exactly. This guard is intentionally SKIPPED when `city`
 * is not given — same as the app: with no city, an ambiguous cross-city hit
 * is already refused by the ambiguity check below, and some of these strings
 * (e.g. "Bin Qasim Town") are themselves valid, unambiguous canonical town
 * names when not scoped to the one city where they are also an
 * administrative parent.
 *
 * With `city` given, only that city is searched. Without it, every city in
 * the registry is searched, and a name matching towns in more than one city
 * is ambiguous (returns null) — town names such as "Cantt" and "Model Town"
 * repeat across cities, so an unscoped hit does not identify a single place.
 *
 * Deprecated candidates are dropped BEFORE ambiguity is judged. A deprecated
 * town's own name can tie with a live neighbour's alias for the same string —
 * e.g. Karachi's "Shanti Nagar" is both a hidden former town (in
 * `deprecatedTowns`) and an alias its real parent Gulshan-e-Iqbal carries
 * (re-parented rather than retired) — and that tie must resolve to the live
 * parent, not go ambiguous or silently prefer whichever was found first. This
 * exact bug existed in the app's resolver before being fixed there; the same
 * fix is ported here. A tie between two LIVE towns is left untouched and
 * returns null.
 *
 * NOT reproduced: the app's affix-tolerant pass — stripping an administrative
 * "Town" suffix or Islamabad's "Sector" prefix so e.g. "Landhi Town" matches
 * "Landhi", or bare "SITE" matches "S.I.T.E. Town". That data is not exported
 * into the committed artifact, so there is nothing here to drive it — a raw
 * string only the app's affix pass would catch is a miss here rather than a
 * resolution, which fails in the same safe direction as every other miss.
 * (Plain fold equality, e.g. "SITE Town" == "S.I.T.E. Town", IS reproduced —
 * that needs no affix stripping, just `foldName` on both sides.)
 */
export function resolveGeocodedName(
  raw: string,
  city?: string,
): ResolvedLocation | null {
  const value = normalizeKey(raw);
  if (!value) return null;

  const needle = foldName(value);
  if (!needle) return null;

  const scopedCity = normalizeKey(city);

  if (scopedCity && getCityIndex(scopedCity)?.coarseAdminUnits.has(needle)) {
    return null;
  }

  const candidateCities = scopedCity ? [scopedCity] : Object.keys(registry.cities);

  // Keyed by "City::Town" so a town name repeated across cities ("Cantt",
  // "Model Town") produces one candidate per city rather than collapsing
  // into a single, possibly wrong, answer. Within one city, a canonical-town
  // self-match and an alias match pointing at a DIFFERENT town can both fire
  // for the same needle (the Shanti Nagar case above) — both are recorded so
  // the deprecated-filter below can pick between them.
  const matches = new Map<string, ResolvedLocation>();

  for (const candidateCity of candidateCities) {
    const index = getCityIndex(candidateCity);
    if (!index) continue;

    const townMatch = index.townByFold.get(needle);
    if (townMatch) {
      matches.set(`${candidateCity}::${townMatch}`, { city: candidateCity, town: townMatch });
    }

    const aliasMatch = index.aliasByFold.get(needle);
    if (aliasMatch) {
      matches.set(`${candidateCity}::${aliasMatch}`, { city: candidateCity, town: aliasMatch });
    }
  }

  let candidates = [...matches.values()];
  if (candidates.length > 1) {
    const live = candidates.filter(
      (candidate) => !getCityIndex(candidate.city)?.deprecated.has(candidate.town),
    );
    if (live.length > 0) candidates = live;
  }

  if (candidates.length !== 1) return null;
  const resolved = candidates[0];

  if (getCityIndex(resolved.city)?.deprecated.has(resolved.town)) return null;
  return resolved;
}
