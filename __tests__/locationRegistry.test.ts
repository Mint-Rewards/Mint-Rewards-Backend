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
});

describe("cityHasTowns", () => {
  it("is true for cities with a curated towns list", () => {
    expect(cityHasTowns("Karachi")).toBe(true);
  });

  it("defaults to false for cities without one, and unknown cities", () => {
    expect(cityHasTowns("Abbottabad")).toBe(false);
    expect(cityHasTowns("Nonexistent City")).toBe(false);
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
