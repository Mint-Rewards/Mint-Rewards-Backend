/**
 * MINOR-3: a fold (or affix-variant) collision between two LIVE towns within
 * one city must produce ambiguity (null, via the existing ambiguity path —
 * see resolveGeocodedName's ambiguity handling in lib/locationRegistry.ts),
 * never last-write-wins.
 *
 * No such collision exists in the real committed artifact today (verified by
 * a one-off audit across every city — see the fix-round notes), so this
 * suite mocks a small synthetic registry to exercise the collision path
 * directly, mirroring the app resolver's own semantics: a `Map` overwrite on
 * a colliding key would silently prefer whichever town was indexed last,
 * which is exactly the bug this test guards against.
 */
jest.mock(
  "@/lib/data/locationRegistry.json",
  () => ({
    version: 1,
    cities: {
      // Plain-fold collision: punctuation-only difference, unrelated to the
      // affix-tolerant ("Town"/"Sector") pass — isolates MINOR-3 from
      // IMPORTANT-1.
      "Test City": {
        province: "Testland",
        tier: "A",
        hasTowns: true,
        towns: ["North East", "North-East"],
        selectableTowns: ["North East", "North-East"],
        deprecatedTowns: [],
        aliases: {},
        coarseAdminUnits: [],
      },
      // Affix-variant collision: "Riverside Town"'s "Town"-stripped variant
      // ("riverside") collides with "Riverside"'s own plain fold — a
      // collision the affix-tolerant pass itself introduces.
      "Variant City": {
        province: "Testland",
        tier: "A",
        hasTowns: true,
        towns: ["Riverside", "Riverside Town"],
        selectableTowns: ["Riverside", "Riverside Town"],
        deprecatedTowns: [],
        aliases: {},
        coarseAdminUnits: [],
      },
    },
  }),
  { virtual: true },
);

// Imported after the mock so the module builds its per-city index off the
// synthetic registry above, not the real committed artifact.
const { resolveGeocodedName } = require("@/lib/locationRegistry");

describe("resolveGeocodedName — fold-collision ambiguity (MINOR-3)", () => {
  it("returns null (ambiguous) for a plain-fold collision between two live towns", () => {
    // "North East" and "North-East" both fold to "northeast" — a
    // single-valued map would silently prefer whichever was indexed last.
    expect(resolveGeocodedName("North East", "Test City")).toBeNull();
    expect(resolveGeocodedName("North-East", "Test City")).toBeNull();
    expect(resolveGeocodedName("northeast", "Test City")).toBeNull();
  });

  it("returns null (ambiguous) for an affix-variant collision between two live towns", () => {
    // "Riverside Town"'s Town-stripped variant ("riverside") collides with
    // "Riverside"'s own plain fold — neither is deprecated, so this is a
    // genuine tie, not the deprecated/live tie-break case.
    expect(resolveGeocodedName("Riverside", "Variant City")).toBeNull();
    expect(resolveGeocodedName("Riverside Town", "Variant City")).toBeNull();
  });
});
