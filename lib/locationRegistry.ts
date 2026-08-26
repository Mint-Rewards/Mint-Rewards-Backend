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
 * guard, then exact, then folded, then alias, then the app's affix-tolerant
 * pass, with deprecated-town handling) mirror the app's own
 * `utils/pakistan_areas.ts`. See each function's doc comment for exactly what
 * is, and is not, reproduced here. City lookups (`getProvinceForCity`,
 * `getCoverageTier`, `cityHasTowns`, and the city-scoping in
 * `resolveGeocodedName`) are fold-tolerant, since a third-party geocoder's
 * city string ("karachi", "KARACHI") is never guaranteed to match the
 * registry's exact casing. (The `COARSE_ADMIN_UNITS` guard WAS missing in
 * the first cut of this module and was added in a fix round — see
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

// MINOR-7: this module hard-codes assumptions about the artifact's shape
// (e.g. every accessor below reads `entry.towns`/`entry.aliases` directly,
// with no defensive check). A version bump the reader forgot to account for
// should fail loudly at import time, not quietly misbehave the first time a
// request touches a shape that changed underneath it.
if (registry.version !== 1) {
  throw new Error(
    `lib/data/locationRegistry.json declares version ${registry.version}, ` +
      "but lib/locationRegistry.ts only understands version 1. Regenerate " +
      "the artifact and update this guard (and the accessors below) if the " +
      "schema changed intentionally.",
  );
}

function normalizeKey(value: string | undefined | null): string {
  return (value || "").trim();
}

// ---------------------------------------------------------------------------
// Fold-tolerant city resolution (IMPORTANT-2)
// ---------------------------------------------------------------------------

/**
 * foldedCityName -> canonical registry key ("Karachi", not "karachi").
 * Built once, lazily, on first use — the city list is small (< 60 entries)
 * and never changes at runtime.
 */
let cityFoldIndex: Map<string, string> | null = null;

function getCityFoldIndex(): Map<string, string> {
  if (cityFoldIndex) return cityFoldIndex;
  cityFoldIndex = new Map();
  for (const cityKey of Object.keys(registry.cities)) {
    cityFoldIndex.set(foldName(cityKey), cityKey);
  }
  return cityFoldIndex;
}

/**
 * Resolves a raw city string to its canonical registry key, exact match
 * first and folded match second — so a third-party geocoder's "karachi" or
 * "KARACHI" resolves the same city entry as the registry's own "Karachi".
 * Returns undefined when neither an exact nor a folded key exists.
 */
function resolveCityKey(city: string | undefined | null): string | undefined {
  const key = normalizeKey(city);
  if (!key) return undefined;
  if (registry.cities[key]) return key;
  const folded = foldName(key);
  if (!folded) return undefined;
  return getCityFoldIndex().get(folded);
}

function getCityEntry(city: string): CityEntry | undefined {
  const key = resolveCityKey(city);
  return key ? registry.cities[key] : undefined;
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
 * Folded spellings a name may legitimately arrive under. Ported VERBATIM
 * from the app repo's `nameVariants` (utils/pakistan_areas.ts:1590-1603).
 *
 * Geocoders and this registry disagree on two suffix/prefix conventions, and
 * the disagreement is systematic rather than per-place:
 *
 *   - Administrative "Town" suffix. Geocoders return "Landhi Town" and
 *     "North Nazimabad Town" for areas this registry calls "Landhi" and
 *     "North Nazimabad".
 *   - Islamabad "Sector" prefix. Geocoders return "E-7"; the registry says
 *     "Sector E-7".
 *
 * Variants are generated for BOTH sides of the comparison (the query string
 * AND every registered town/alias — see `getCityIndex` below), so the rule
 * works whichever side carries the affix. Both strips are floored on the
 * remainder so a bare "Town" or "Sector" cannot fold to the empty string and
 * then match everything.
 */
function nameVariants(value: string): Set<string> {
  const out = new Set<string>();
  const folded = foldName(value);
  if (!folded) return out;
  out.add(folded);

  const withoutTown = folded.replace(/town$/, "");
  if (withoutTown.length >= 3) out.add(withoutTown);

  const withoutSector = folded.replace(/^sector/, "");
  if (withoutSector.length >= 2) out.add(withoutSector);

  return out;
}

/**
 * Per-city lookup used by `resolveGeocodedName`, built once per city on
 * first use and cached.
 *
 * `townByFold` and `aliasByFold` are keyed by every FOLDED VARIANT
 * (`nameVariants`, not just the plain fold) of each town/alias, mapped to a
 * SET of canonical towns — not a single town — for two reasons that both
 * trace back to the same fact (a fold key is not guaranteed unique):
 *
 *  1. Affix-tolerant matching (IMPORTANT-1): "Sector E-7"'s variants include
 *     "e7" (the "Sector" prefix stripped) alongside its plain fold
 *     "sectore7", so a query of "E-7" — which has no affix of its own to
 *     strip — still lands in the same bucket via the town side's stripped
 *     variant. Folding both the query and every registered name into the
 *     same variant space, rather than stripping only one side, is what lets
 *     the rule fire regardless of which side carries the affix.
 *  2. Ambiguity on collision (MINOR-3): if two DIFFERENT towns in one city
 *     happen to fold (or affix-fold) to the same variant, a single-valued
 *     map would silently pick whichever was written last. Storing a set
 *     preserves both candidates, so `resolveGeocodedName`'s existing
 *     ambiguity path (see below) returns null instead of guessing.
 */
interface CityIndex {
  townByFold: Map<string, Set<string>>; // folded variant -> canonical town(s)
  aliasByFold: Map<string, Set<string>>; // folded variant -> canonical town(s) the alias(es) point to
  deprecated: Set<string>; // canonical town names hidden from new selections
  coarseAdminUnits: Set<string>; // already-folded administrative-parent strings
}

function addVariants(
  map: Map<string, Set<string>>,
  variants: Set<string>,
  town: string,
): void {
  for (const variant of variants) {
    let bucket = map.get(variant);
    if (!bucket) {
      bucket = new Set();
      map.set(variant, bucket);
    }
    bucket.add(town);
  }
}

const cityIndexCache = new Map<string, CityIndex | null>();

function getCityIndex(city: string): CityIndex | null {
  const cacheKey = normalizeKey(city);
  const cached = cityIndexCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const resolvedKey = resolveCityKey(cacheKey);
  const entry = resolvedKey ? registry.cities[resolvedKey] : undefined;
  if (!entry) {
    cityIndexCache.set(cacheKey, null);
    return null;
  }

  const townByFold = new Map<string, Set<string>>();
  for (const town of entry.towns) {
    addVariants(townByFold, nameVariants(town), town);
  }

  const aliasByFold = new Map<string, Set<string>>();
  for (const [alias, town] of Object.entries(entry.aliases)) {
    addVariants(aliasByFold, nameVariants(alias), town);
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
  cityIndexCache.set(cacheKey, index);
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
 * resolution order is exact match, then folded match, then alias match, then
 * the affix-tolerant ("Town" suffix / Islamabad "Sector" prefix) pass — all
 * compared via `foldName`/`nameVariants`, since an exact string match is
 * always also a folded match, which is always also a variant match. A folded
 * query that matches nothing (or matches ambiguously) is a miss, never a
 * guess.
 *
 * COARSE-ADMIN-UNIT GUARD (runs before any matching, only when `city` is
 * given): an administrative parent — e.g. "Gulberg Town" in Karachi, which
 * spans many registered areas, or "Bin Qasim Town", "Jamshed Town",
 * "S.I.T.E. Town" — has no single right answer, so every available answer is
 * wrong for most of its residents. A raw string whose `foldName(...)` is in
 * that city's `coarseAdminUnits` refuses before matching even starts,
 * mirroring the app's `isCoarseAdminUnit` check and its position (before
 * exact/fold/alias/affix) exactly — the affix-tolerant pass below would
 * otherwise happily fold "Gulberg Town" to "gulberg" and hand back a
 * confident, wrong area. This guard is intentionally SKIPPED when `city` is
 * not given — same as the app: with no city, an ambiguous cross-city hit is
 * already refused by the ambiguity check below, and some of these strings
 * (e.g. "Bin Qasim Town") are themselves valid, unambiguous canonical town
 * names when not scoped to the one city where they are also an
 * administrative parent.
 *
 * `city` (and the coarse-admin-unit guard's own city scoping) is resolved
 * fold-tolerantly — see `resolveCityKey` — so "karachi" scopes identically
 * to "Karachi" before any town/alias matching runs.
 *
 * With `city` given, only that city is searched. Without it, every city in
 * the registry is searched, and a name matching towns in more than one city
 * is ambiguous (returns null) — town names such as "Cantt" and "Model Town"
 * repeat across cities, so an unscoped hit does not identify a single place.
 *
 * AFFIX-TOLERANT PASS (IMPORTANT-1, ported from the app's `nameVariants` /
 * `resolveGeocodedName`, utils/pakistan_areas.ts:1590-2023): `townByFold` and
 * `aliasByFold` (see `getCityIndex`) are keyed by every folded VARIANT of
 * each town/alias, not just its plain fold, so a query variant intersecting
 * any registered variant is a hit. This runs logically after exact/fold/alias
 * matching and after the coarse-admin-unit guard, mirroring the app's
 * ordering exactly: the guard refuses before ANY matching (including the
 * affix pass) starts, and the app's own per-town loop always checks
 * exact-self-match and alias-exact-match before falling through to the
 * variant checks. Here, all of those checks are folded into one lookup per
 * needle variant — which is equivalent to the app's ordering rather than a
 * departure from it, because every check ultimately just answers "is this
 * town a candidate," and a town keyed by a shared `Map<..., Set<town>>` is a
 * candidate exactly once no matter which check (or which order of checks)
 * puts it there.
 *
 * Deprecated candidates are dropped BEFORE ambiguity is judged. A deprecated
 * town's own name can tie with a live neighbour's alias for the same string —
 * e.g. Karachi's "Shanti Nagar" is both a hidden former town (in
 * `deprecatedTowns`) and an alias its real parent Gulshan-e-Iqbal carries
 * (re-parented rather than retired) — and that tie must resolve to the live
 * parent, not go ambiguous or silently prefer whichever was found first. This
 * exact bug existed in the app's resolver before being fixed there; the same
 * fix is ported here. A tie between two LIVE towns is left untouched and
 * returns null. The same mechanism now also catches a plain fold/variant
 * COLLISION between two live towns (MINOR-3) — `townByFold`/`aliasByFold`
 * map each folded variant to a SET of towns, so two distinct towns sharing a
 * variant both surface as candidates instead of one silently overwriting the
 * other, and (absent a deprecated tie-break) an unresolved tie between two
 * live towns falls through to this same "ambiguous, return null" path.
 */
export function resolveGeocodedName(
  raw: string,
  city?: string,
): ResolvedLocation | null {
  const value = normalizeKey(raw);
  if (!value) return null;

  const needle = foldName(value);
  if (!needle) return null;

  const needleVariants = nameVariants(value);

  const scopedCityInput = normalizeKey(city);
  // Resolved to the registry's canonical casing up front (fold-tolerant, per
  // IMPORTANT-2) so every match recorded below — and the final returned
  // `city` — uses that canonical form, never whatever casing the geocoder
  // happened to send. Falls back to the raw input when it does not resolve
  // to any known city, which preserves the pre-fix behavior of "scope to a
  // city that turns out not to exist" -> no candidates, same as a miss.
  const scopedCity = scopedCityInput
    ? (resolveCityKey(scopedCityInput) ?? scopedCityInput)
    : undefined;

  if (scopedCity && getCityIndex(scopedCity)?.coarseAdminUnits.has(needle)) {
    return null;
  }

  const candidateCities = scopedCity
    ? [scopedCity]
    : Object.keys(registry.cities);

  // Keyed by "City::Town" so a town name repeated across cities ("Cantt",
  // "Model Town") produces one candidate per city rather than collapsing
  // into a single, possibly wrong, answer.
  const matches = new Map<string, ResolvedLocation>();

  for (const candidateCity of candidateCities) {
    const index = getCityIndex(candidateCity);
    if (!index) continue;

    for (const variant of needleVariants) {
      const townMatches = index.townByFold.get(variant);
      if (townMatches) {
        for (const town of townMatches) {
          matches.set(`${candidateCity}::${town}`, { city: candidateCity, town });
        }
      }

      const aliasMatches = index.aliasByFold.get(variant);
      if (aliasMatches) {
        for (const town of aliasMatches) {
          matches.set(`${candidateCity}::${town}`, { city: candidateCity, town });
        }
      }
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
