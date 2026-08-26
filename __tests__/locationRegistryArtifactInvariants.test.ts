/**
 * IMPORTANT-3 (artifact sync guard, backend side).
 *
 * This suite is NOT — and cannot be — a cross-repo sync check. A checksum or
 * deep-equal against "what the app repo currently produces" is not possible
 * from here: this repo has no access to the app repo's source, only the
 * committed copy of its output (`lib/data/locationRegistry.json`). True
 * cross-repo sync relies on two things neither of which this file can
 * enforce:
 *
 *   1. The app repo's OWN regression test
 *      (`Mint-Rewards-App/__tests__/exportLocationRegistry.test.ts`), which
 *      asserts the app's in-process export is deep-equal to ITS committed
 *      fixture (`utils/__generated__/locationRegistry.json`).
 *   2. The regeneration discipline documented in the app repo's
 *      `scripts/export_location_registry.ts` header: any `pakistan_areas.ts`
 *      change must regenerate BOTH that fixture and this repo's
 *      `lib/data/locationRegistry.json`, and both are committed by hand.
 *
 * What this suite CAN do, and does: assert the committed artifact itself is
 * structurally sound — the invariants `lib/locationRegistry.ts` silently
 * relies on — so a hand-edited or partially-regenerated artifact fails loudly
 * here rather than misbehaving at request time. It also pins the declared
 * city count, so a city silently dropped from a future regeneration (or a
 * corrupted copy) is caught even though this suite cannot tell WHY the count
 * changed.
 */
import registryData from "@/lib/data/locationRegistry.json";
import { foldName } from "@/lib/locationRegistry";

interface CityEntryShape {
  province: string;
  tier: string;
  hasTowns: boolean;
  towns: string[];
  selectableTowns: string[];
  deprecatedTowns: string[];
  aliases: Record<string, string>;
  coarseAdminUnits: string[];
}

interface RegistryShape {
  version: number;
  cities: Record<string, CityEntryShape>;
}

const registry = registryData as RegistryShape;

describe("committed locationRegistry.json — structural invariants", () => {
  it("declares schema version 1", () => {
    expect(registry.version).toBe(1);
  });

  // Pinned to the artifact as committed on this branch. A change here should
  // only ever accompany a deliberate registry edit (and a matching app-repo
  // regeneration) — not a surprise in an unrelated diff.
  it("declares the expected city count", () => {
    expect(Object.keys(registry.cities).length).toBe(58);
  });

  it("gives every city a province, tier, and towns array", () => {
    for (const [city, entry] of Object.entries(registry.cities)) {
      expect(typeof entry.province).toBe("string");
      expect(entry.province.length).toBeGreaterThan(0);

      expect(["A", "B", "C"]).toContain(entry.tier);

      expect(Array.isArray(entry.towns)).toBe(true);
      expect(typeof entry.hasTowns).toBe("boolean");
      // `hasTowns` is derived from whether the towns list is non-empty — the
      // two must never disagree, or `evaluateLocation`'s area-selectable
      // branch (lib/evaluateLocation.ts) would consult a towns list that
      // contradicts what it was told exists.
      expect(entry.hasTowns).toBe(entry.towns.length > 0);

      expect(Array.isArray(entry.selectableTowns)).toBe(true);
      expect(Array.isArray(entry.deprecatedTowns)).toBe(true);
      expect(Array.isArray(entry.coarseAdminUnits)).toBe(true);
      expect(typeof entry.aliases).toBe("object");
      expect(entry.aliases).not.toBeNull();

      void city; // referenced only for the assertion messages below
    }
  });

  it("keeps selectableTowns a subset of towns, for every city", () => {
    for (const [city, entry] of Object.entries(registry.cities)) {
      const townSet = new Set(entry.towns);
      for (const selectable of entry.selectableTowns) {
        expect(townSet.has(selectable)).toBe(true);
      }
      void city;
    }
  });

  it("keeps coarseAdminUnits members already-folded (subset of the folded-name space)", () => {
    // `resolveGeocodedName` compares `coarseAdminUnits` members directly
    // against `foldName(raw)` with no extra folding step (see
    // lib/locationRegistry.ts) — an unfolded member here would silently
    // never match, which is a correctness bug the accessor has no way to
    // detect at request time.
    for (const [city, entry] of Object.entries(registry.cities)) {
      for (const unit of entry.coarseAdminUnits) {
        expect(foldName(unit)).toBe(unit);
      }
      void city;
    }
  });

  it("keeps aliases pointing only at towns registered in the same city", () => {
    for (const [city, entry] of Object.entries(registry.cities)) {
      const townSet = new Set(entry.towns);
      for (const [alias, town] of Object.entries(entry.aliases)) {
        expect(townSet.has(town)).toBe(true);
        void alias;
      }
      void city;
    }
  });
});
