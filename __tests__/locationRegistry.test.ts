import registryData from "@/lib/data/locationRegistry.json";
import {
  cityHasTowns,
  foldName,
  getCoverageTier,
  getProvinceForCity,
  resolveGeocodedName,
} from "@/lib/locationRegistry";

// All assertions below read the real committed artifact
// (lib/data/locationRegistry.json) via the module under test — no fixtures.
// A drifted or malformed artifact should fail these tests, not a mock.

describe("locationRegistry artifact", () => {
  it("parses and contains Karachi with tier A and >70 towns", () => {
    const karachi = (registryData as typeof registryData & {
      cities: Record<string, { tier: string; towns: string[] }>;
    }).cities["Karachi"];

    expect(karachi).toBeDefined();
    expect(karachi.tier).toBe("A");
    expect(karachi.towns.length).toBeGreaterThan(70);
  });
});

describe("getProvinceForCity", () => {
  it("returns the province for a known city", () => {
    expect(getProvinceForCity("Karachi")).toBe("Sindh");
    expect(getProvinceForCity("Lahore")).toBe("Punjab");
  });

  it("returns null for an unknown city", () => {
    expect(getProvinceForCity("Nonexistent City")).toBeNull();
  });

  // IMPORTANT-2: registry accessors must be fold-tolerant — LocationIQ's
  // city string is third-party and its casing is not guaranteed to match.
  it("is fold-tolerant: resolves regardless of case", () => {
    expect(getProvinceForCity("karachi")).toBe("Sindh");
    expect(getProvinceForCity("KARACHI")).toBe("Sindh");
    expect(getProvinceForCity("KaRaChI")).toBe("Sindh");
  });
});

describe("getCoverageTier", () => {
  it("returns the curated tier for known cities", () => {
    expect(getCoverageTier("Karachi")).toBe("A");
    expect(getCoverageTier("Lahore")).toBe("B");
    expect(getCoverageTier("Islamabad")).toBe("B");
  });

  it("defaults to C for an unlisted city", () => {
    expect(getCoverageTier("Gujranwala")).toBe("C");
    expect(getCoverageTier("Nonexistent City")).toBe("C");
  });

  it("is fold-tolerant", () => {
    expect(getCoverageTier("karachi")).toBe("A");
  });
});

describe("cityHasTowns", () => {
  it("is true for cities with a curated towns list", () => {
    expect(cityHasTowns("Karachi")).toBe(true);
  });

  it("defaults to false for cities without one, and unknown cities", () => {
    expect(cityHasTowns("Abbottabad")).toBe(false);
    expect(cityHasTowns("Nonexistent City")).toBe(false);
  });

  it("is fold-tolerant", () => {
    expect(cityHasTowns("karachi")).toBe(true);
  });
});

// Pairs mirror the app repo's own foldName tests
// (Mint-Rewards-App/__tests__/pakistan_areas_meta.test.ts) and real registry
// strings exercised by its resolveGeocodedName suite, so this asserts
// identical behavior to the app's `foldName`
// (utils/pakistan_areas.ts:103) rather than just this port's self-consistency.
describe("foldName", () => {
  it("matches the app's foldName on real registry strings", () => {
    expect(foldName("Gulshan-e-Iqbal")).toBe(foldName("gulshan e iqbal"));
    expect(foldName("Federal B. Area")).toBe("federalbarea");
    expect(foldName("DHA")).toBe("dha");
    expect(foldName("Defence Housing Authority")).toBe("defencehousingauthority");
    expect(foldName("Sadder")).toBe("sadder");
    expect(foldName("Shanti Nagar")).toBe("shantinagar");
    expect(foldName("P.E.C.H.S.")).toBe(foldName("PECHS"));
  });
});

describe("resolveGeocodedName", () => {
  it("resolves an exact match", () => {
    expect(resolveGeocodedName("Gulshan-e-Iqbal", "Karachi")).toEqual({
      city: "Karachi",
      town: "Gulshan-e-Iqbal",
    });
  });

  it("resolves a folded match (case/punctuation variant)", () => {
    expect(resolveGeocodedName("gulshan e iqbal", "Karachi")).toEqual({
      city: "Karachi",
      town: "Gulshan-e-Iqbal",
    });
  });

  it("resolves an alias hit — a real alias from the artifact", () => {
    // "Shanti Nagar" is simultaneously a deprecated former Karachi town AND
    // the alias its live parent Gulshan-e-Iqbal carries (re-parented rather
    // than retired). The deprecated self-match must be dropped before
    // ambiguity is judged, leaving the live parent as the sole candidate —
    // this is the exact tie the app repo's resolver once got wrong.
    expect(resolveGeocodedName("Shanti Nagar", "Karachi")).toEqual({
      city: "Karachi",
      town: "Gulshan-e-Iqbal",
    });
    // Same alias, another registered spelling of "Sadder" -> "Saddar".
    expect(resolveGeocodedName("Sadder", "Karachi")).toEqual({
      city: "Karachi",
      town: "Saddar",
    });
  });

  it("returns null for a name matching only a deprecated town", () => {
    // "Askari" is a deprecated Karachi town with no alias claiming it (the
    // numbered Askari 1-5 schemes are deliberately never aliased to it), so
    // this is a single deprecated candidate, not a tie.
    expect(resolveGeocodedName("Askari", "Karachi")).toBeNull();
  });

  it("returns null for an unknown name", () => {
    expect(resolveGeocodedName("Nonexistent Place", "Karachi")).toBeNull();
    expect(resolveGeocodedName("", "Karachi")).toBeNull();
  });

  it("returns null on cross-city ambiguity when unscoped, and resolves once scoped", () => {
    // "Cantt" is a live town in more than one city's registry, so an
    // unscoped search cannot pick one without guessing.
    expect(resolveGeocodedName("Cantt")).toBeNull();
    expect(resolveGeocodedName("Cantt", "Lahore")).toEqual({
      city: "Lahore",
      town: "Cantt",
    });
  });

  it("is total on empty and whitespace input", () => {
    expect(resolveGeocodedName("   ")).toBeNull();
    expect(resolveGeocodedName("...")).toBeNull();
  });
});

// COARSE_ADMIN_UNITS guard (fix round): the app never resolves an
// administrative parent to a single area, since one parent spans many
// registered children and any single answer would be wrong for most of its
// residents. Cases below are verified directly against the app repo's own
// resolveGeocodedName (utils/pakistan_areas.ts) to confirm parity, not just
// self-consistency of this port. See __tests__/pakistan_areas_meta.test.ts:
// 710-721 in the app repo for the app's own "Bin Qasim Town" / picker-overlap
// assertions this mirrors.
describe("resolveGeocodedName — coarse administrative units", () => {
  it("refuses to resolve a coarse admin unit when a city scopes the search", () => {
    // Exact-string coarse-unit names.
    expect(resolveGeocodedName("Bin Qasim Town", "Karachi")).toBeNull();
    expect(resolveGeocodedName("Jamshed Town", "Karachi")).toBeNull();
    expect(resolveGeocodedName("S.I.T.E. Town", "Karachi")).toBeNull();
    // "SITE Town" reaches the guard via plain fold equality with
    // "S.I.T.E. Town" (foldName collapses both to "sitetown") — no
    // affix-tolerant stripping involved, so this is within this port's scope.
    expect(resolveGeocodedName("SITE Town", "Karachi")).toBeNull();
  });

  it("does not leak one city's administrative parent onto another city", () => {
    // "Cantonment" is a coarse admin unit ONLY in Karachi (COARSE_ADMIN_UNITS
    // is keyed per city); Quetta has "Cantonment" as its own genuine,
    // resolvable canonical town, so the same string must resolve there.
    expect(resolveGeocodedName("Cantonment", "Karachi")).toBeNull();
    expect(resolveGeocodedName("Cantonment", "Quetta")).toEqual({
      city: "Quetta",
      town: "Cantonment",
    });
  });

  it("does not apply the guard when the search is unscoped", () => {
    // Unscoped, these three strings are themselves valid, unambiguous
    // canonical town names (each also happens to be Karachi's own coarse
    // admin unit for that string) — the app's resolver only calls
    // isCoarseAdminUnit when a city narrows the search, so an unscoped hit
    // resolves normally here too.
    expect(resolveGeocodedName("Bin Qasim Town")).toEqual({
      city: "Karachi",
      town: "Bin Qasim Town",
    });
    expect(resolveGeocodedName("Jamshed Town")).toEqual({
      city: "Karachi",
      town: "Jamshed Town",
    });
    expect(resolveGeocodedName("S.I.T.E. Town")).toEqual({
      city: "Karachi",
      town: "S.I.T.E. Town",
    });
  });

  it("still resolves a live area that merely sounds administrative", () => {
    // "Orangi Town" is a genuine registered town, not a coarse admin unit —
    // the guard must not overreach onto names that just contain "Town".
    expect(resolveGeocodedName("Orangi Town", "Karachi")).toEqual({
      city: "Karachi",
      town: "Orangi Town",
    });
  });
});

// IMPORTANT-1: the app's affix-tolerant pass, ported verbatim (nameVariants,
// utils/pakistan_areas.ts:1129-1144). Every expectation below was verified
// directly against the app repo's own `resolveGeocodedName` (a throwaway
// probe importing utils/pakistan_areas.ts) to confirm parity, not just this
// port's self-consistency — same standard as the coarse-admin-unit suite
// above.
describe("resolveGeocodedName — affix-tolerant pass", () => {
  it("strips an administrative 'Town' suffix the geocoder adds but the registry doesn't carry", () => {
    expect(resolveGeocodedName("Landhi Town", "Karachi")).toEqual({
      city: "Karachi",
      town: "Landhi",
    });
    expect(resolveGeocodedName("Korangi Town", "Karachi")).toEqual({
      city: "Karachi",
      town: "Korangi",
    });
    expect(resolveGeocodedName("New Karachi Town", "Karachi")).toEqual({
      city: "Karachi",
      town: "New Karachi",
    });
  });

  it("strips Islamabad's 'Sector' prefix the registry carries but the geocoder doesn't", () => {
    expect(resolveGeocodedName("E-7", "Islamabad")).toEqual({
      city: "Islamabad",
      town: "Sector E-7",
    });
    expect(resolveGeocodedName("G-11", "Islamabad")).toEqual({
      city: "Islamabad",
      town: "Sector G-11",
    });
  });

  it("still refuses a coarse admin unit even though its fold is now variant-reachable", () => {
    // The coarse-admin-unit guard must run BEFORE the affix pass gets a
    // chance to fold "Gulberg Town" down to "gulberg" and hand back a
    // confident, wrong single area — see the guard's own doc comment.
    expect(resolveGeocodedName("Gulberg Town", "Karachi")).toBeNull();
  });
});

// IMPORTANT-2: city lookup itself must be fold-tolerant, since LocationIQ's
// city string is third-party and its casing is not guaranteed to match the
// registry's.
describe("resolveGeocodedName — fold-tolerant city scoping", () => {
  it("scopes identically whether the city arrives lowercase, uppercase, or canonical", () => {
    const expected = { city: "Karachi", town: "Gulshan-e-Iqbal" };
    expect(resolveGeocodedName("Gulshan-e-Iqbal", "karachi")).toEqual(expected);
    expect(resolveGeocodedName("Gulshan-e-Iqbal", "KARACHI")).toEqual(expected);
    expect(resolveGeocodedName("Gulshan-e-Iqbal", "Karachi")).toEqual(expected);
  });

  it("returns the canonical city casing even when scoped by a folded variant", () => {
    const resolved = resolveGeocodedName("DHA", "karachi");
    expect(resolved?.city).toBe("Karachi");
  });
});
