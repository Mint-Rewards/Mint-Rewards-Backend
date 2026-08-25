/**
 * P3.1 — pure bucketing unit tests for scripts/location-backfill-audit.js.
 *
 * Only the pure, DB-free surface of that script is exercised here (per the
 * task brief: "the script entrypoint itself stays out of jest"). A synthetic
 * registry context stands in for the real artifact so every bucket —
 * including agree/disagree/no_centroid, which the REAL committed artifact
 * can never produce today (AREA_CENTROIDS/CITY_CENTROIDS ship empty, and
 * even once populated they carry no maxSampleRadiusMeters — see
 * buildRegistryContext's own comment) — is reachable and asserted here.
 */
// scripts/location-backfill-audit.js is plain CommonJS (this repo's scripts
// are .js — see that file's own header for why). `esModuleInterop` +
// `allowJs` let it be imported like any other module rather than required.
import {
  bucketUser,
  buildRegistryContext,
  buildReportHeader,
  computeContainmentThresholdMeters,
  cityTownKey,
  haversineMeters,
  parseUserCoordinates,
  roundCoordinate,
  DISAGREE_LANGUAGE_DISCIPLINE,
} from "../scripts/location-backfill-audit.js";

// ---------------------------------------------------------------------------
// Synthetic registry — deliberately NOT the real artifact, so every bucket
// (agree/disagree/no_centroid especially) is exercisable regardless of the
// real registry's current (empty) centroid coverage.
// ---------------------------------------------------------------------------

const CENTROID = { lat: 20.0, lng: 10.0 }; // [lng, lat] = [10, 20]
const MAX_SAMPLE_RADIUS_METERS = 1000; // heuristic = 1500, floor 2000 wins -> threshold 2000m

const rawArtifact = {
  version: 1,
  cities: {
    Testville: {
      towns: ["Uptown", "Old Quarter"],
      deprecatedTowns: ["Ghost Town"],
    },
  },
  deprecatedSubAreas: {
    "Testville::Uptown": ["Old Market Road"],
    // References a town absent from `towns`/`deprecatedTowns` on purpose —
    // proves bucket 1 (deprecated_sub_area) outranks bucket 2 (unresolvable)
    // even when both would otherwise fire.
    "Testville::Ghost Town2": ["Weird Road"],
  },
  areaCentroids: { areas: {}, cities: {} },
};

const centroidsOverride = {
  "Testville::Uptown": {
    centroid: [CENTROID.lng, CENTROID.lat] as [number, number],
    maxSampleRadiusMeters: MAX_SAMPLE_RADIUS_METERS,
  },
  // "Testville::Old Quarter" deliberately has none -> no_centroid.
};

const ctx = buildRegistryContext(rawArtifact, centroidsOverride);

function point(lat: number, lng: number) {
  return { type: "Point", coordinates: [lng, lat] };
}

describe("bucketUser — every bucket", () => {
  it("buckets deprecated_sub_area when city/town/subArea matches a deprecated entry", () => {
    const user = { city: "Testville", town: "Uptown", subArea: "Old Market Road" };
    expect(bucketUser(user, ctx).bucket).toBe("deprecated_sub_area");
  });

  it("buckets unresolvable when the stated town is absent from towns and deprecatedTowns", () => {
    const user = { city: "Testville", town: "Nowhere" };
    expect(bucketUser(user, ctx).bucket).toBe("unresolvable");
  });

  it("buckets no_pin when there is no usable coordinate", () => {
    const user = { city: "Testville", town: "Uptown", subArea: "New Market" };
    expect(bucketUser(user, ctx).bucket).toBe("no_pin");
  });

  it("buckets no_centroid when the stated (resolvable) town has no centroid on record", () => {
    const user = {
      city: "Testville",
      town: "Old Quarter",
      location: point(20.0, 10.0),
    };
    const result = bucketUser(user, ctx);
    expect(result.bucket).toBe("no_centroid");
    expect(result.distanceMeters).toBeNull();
  });

  it("buckets agree when the pin is within the containment threshold", () => {
    // ~555m north of the centroid — well inside the 2000m floor threshold.
    const user = {
      city: "Testville",
      town: "Uptown",
      location: point(20.005, 10.0),
    };
    const result = bucketUser(user, ctx);
    expect(result.bucket).toBe("agree");
    expect(result.distanceMeters).toBeLessThanOrEqual(2000);
  });

  it("buckets disagree when the pin is beyond the containment threshold", () => {
    // ~5.5km north of the centroid — well beyond the 2000m threshold.
    const user = {
      city: "Testville",
      town: "Uptown",
      location: point(20.05, 10.0),
    };
    const result = bucketUser(user, ctx);
    expect(result.bucket).toBe("disagree");
    expect(result.distanceMeters).toBeGreaterThan(2000);
  });

  it("falls back to legacy latitude/longitude strings when location.coordinates is absent", () => {
    const user = {
      city: "Testville",
      town: "Uptown",
      latitude: "20.005",
      longitude: "10.0",
    };
    const result = bucketUser(user, ctx);
    expect(result.bucket).toBe("agree");
  });
});

describe("bucketUser — priority order", () => {
  it("deprecated_sub_area outranks unresolvable when both would otherwise fire", () => {
    const user = { city: "Testville", town: "Ghost Town2", subArea: "Weird Road" };
    expect(bucketUser(user, ctx).bucket).toBe("deprecated_sub_area");
  });

  it("unresolvable outranks no_pin (an unresolvable town with no coordinate is still unresolvable)", () => {
    const user = { city: "Testville", town: "Nowhere" };
    const result = bucketUser(user, ctx);
    expect(result.bucket).toBe("unresolvable");
    expect(result.bucket).not.toBe("no_pin");
  });

  it("unresolvable outranks agree (an unresolvable town is never distance-checked, even with a pin)", () => {
    const user = {
      city: "Testville",
      town: "Nowhere",
      location: point(20.0, 10.0),
    };
    expect(bucketUser(user, ctx).bucket).toBe("unresolvable");
  });
});

describe("bucketUser — deprecated-town-still-resolvable case", () => {
  it("a deprecated (but registered) town is NOT unresolvable", () => {
    const user = { city: "Testville", town: "Ghost Town" };
    const result = bucketUser(user, ctx);
    expect(result.bucket).not.toBe("unresolvable");
    // No coordinate on this fixture, so it falls through to no_pin — the
    // point being asserted is that it did NOT stop at "unresolvable".
    expect(result.bucket).toBe("no_pin");
  });

  it("a deprecated town with a pin and no centroid still reaches no_centroid, not unresolvable", () => {
    const user = {
      city: "Testville",
      town: "Ghost Town",
      location: point(20.0, 10.0),
    };
    expect(bucketUser(user, ctx).bucket).toBe("no_centroid");
  });
});

describe("computeContainmentThresholdMeters — threshold edge", () => {
  it("floors at 2km when 1.5x the sample radius is below the floor", () => {
    expect(computeContainmentThresholdMeters(1000, undefined)).toBe(2000);
  });

  it("uses the 1.5x heuristic once it exceeds the 2km floor", () => {
    expect(computeContainmentThresholdMeters(2000, undefined)).toBe(3000);
  });

  it("sits exactly at the crossover point (radius x 1.5 == floor)", () => {
    // 2000 / 1.5 = 1333.33...
    expect(computeContainmentThresholdMeters(2000 / 1.5, undefined)).toBe(2000);
  });

  it("a --threshold-km override replaces the heuristic entirely, regardless of radius", () => {
    expect(computeContainmentThresholdMeters(50000, 1)).toBe(1000);
    expect(computeContainmentThresholdMeters(1, 5)).toBe(5000);
  });
});

describe("bucketUser — threshold boundary is inclusive (<=)", () => {
  // Finds, by bisection over the exported haversineMeters, the latitude
  // offset from CENTROID whose distance rounds to exactly targetMeters —
  // avoids hard-coding Earth's radius independently of the module under
  // test.
  function offsetForDistance(targetMeters: number): number {
    let lo = 0;
    let hi = 1; // degrees latitude
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const d = haversineMeters(CENTROID, { lat: CENTROID.lat + mid, lng: CENTROID.lng });
      if (d < targetMeters) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  it("a pin at exactly the threshold distance is agree, not disagree", () => {
    const deltaLat = offsetForDistance(2000);
    const user = {
      city: "Testville",
      town: "Uptown",
      location: point(CENTROID.lat + deltaLat, CENTROID.lng),
    };
    const result = bucketUser(user, ctx);
    expect(result.distanceMeters).toBe(2000);
    expect(result.bucket).toBe("agree");
  });

  it("one meter beyond the threshold is disagree", () => {
    const deltaLat = offsetForDistance(2001);
    const user = {
      city: "Testville",
      town: "Uptown",
      location: point(CENTROID.lat + deltaLat, CENTROID.lng),
    };
    const result = bucketUser(user, ctx);
    expect(result.distanceMeters).toBe(2001);
    expect(result.bucket).toBe("disagree");
  });
});

describe("parseUserCoordinates", () => {
  it("prefers location.coordinates ([lng, lat]) over legacy latitude/longitude", () => {
    const user = {
      latitude: "1.111",
      longitude: "2.222",
      location: { coordinates: [10, 20] }, // [lng, lat]
    };
    expect(parseUserCoordinates(user)).toEqual({ lat: 20, lng: 10 });
  });

  it("falls back to legacy latitude/longitude strings when location.coordinates is missing", () => {
    const user = { latitude: "24.86", longitude: "67.00" };
    expect(parseUserCoordinates(user)).toEqual({ lat: 24.86, lng: 67.0 });
  });

  it("falls back when location.coordinates is malformed (wrong length / non-numeric)", () => {
    const user1 = { latitude: "24.86", longitude: "67.00", location: { coordinates: [1] } };
    expect(parseUserCoordinates(user1)).toEqual({ lat: 24.86, lng: 67.0 });

    const user2 = {
      latitude: "24.86",
      longitude: "67.00",
      location: { coordinates: ["x", "y"] },
    };
    expect(parseUserCoordinates(user2)).toEqual({ lat: 24.86, lng: 67.0 });
  });

  it("returns null when neither representation parses", () => {
    expect(parseUserCoordinates({ latitude: "", longitude: "" })).toBeNull();
    expect(parseUserCoordinates({})).toBeNull();
  });
});

describe("roundCoordinate / cityTownKey", () => {
  it("rounds to 3 decimal places", () => {
    expect(roundCoordinate(24.8602694)).toBe(24.86);
    expect(roundCoordinate(67.00458821)).toBe(67.005);
  });

  it("builds the City::Town composite key", () => {
    expect(cityTownKey("Karachi", "PECHS")).toBe("Karachi::PECHS");
  });
});

describe("bucketUser — distance dedup cache", () => {
  it("reuses the cached distance for the same (town, rounded coordinate) pair", () => {
    const cache = new Map();
    const user = {
      city: "Testville",
      town: "Uptown",
      location: point(20.005, 10.0),
    };
    const first = bucketUser(user, ctx, { distanceCache: cache });
    const second = bucketUser(user, ctx, { distanceCache: cache });
    expect(second.distanceMeters).toBe(first.distanceMeters);
    expect(cache.size).toBe(1);
  });
});

describe("buildReportHeader — language discipline", () => {
  it("states that disagree is not a wrong-address determination and not a geocoder error rate", () => {
    const header = buildReportHeader({
      target: "test",
      dbName: "mint-rewards-test",
      thresholdKm: undefined,
      centroidsSource: "registry artifact",
      totalCentroids: 0,
    });

    expect(header.languageDiscipline).toBe(DISAGREE_LANGUAGE_DISCIPLINE);
    expect(header.languageDiscipline.toLowerCase()).toContain("not a determination that the user's address is wrong");
    expect(header.languageDiscipline.toLowerCase()).toContain("geocoder error rate");
  });

  it("marks the threshold policy as provisional and reports the centroid coverage gap prominently", () => {
    const header = buildReportHeader({
      target: "test",
      dbName: "mint-rewards-test",
      thresholdKm: undefined,
      centroidsSource: "registry artifact",
      totalCentroids: 0,
    });

    expect(header.thresholdPolicy.description.toLowerCase()).toContain("provisional");
    expect(header.centroidCoverage.gapWarning).toBeTruthy();
    expect(header.centroidCoverage.totalTownsWithCentroid).toBe(0);
  });

  it("omits the gap warning once real centroid coverage is present", () => {
    const header = buildReportHeader({
      target: "test",
      dbName: "mint-rewards-test",
      thresholdKm: 3,
      centroidsSource: "./scripts/data/centroids.json",
      totalCentroids: 16,
    });

    expect(header.centroidCoverage.gapWarning).toBeNull();
    expect(header.thresholdPolicy.overrideKm).toBe(3);
  });
});
