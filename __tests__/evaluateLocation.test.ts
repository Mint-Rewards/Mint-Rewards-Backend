import {
  evaluateLocation,
  LOCATION_COMPLETION_VERSION,
  type EvaluableUser,
} from "@/lib/evaluateLocation";

// Karachi: tier A, hasTowns true -> area-selectable requirement set
// (["cityId","areaId","houseNo"]), no pin demanded.
describe("evaluateLocation — tier A/B area-selectable city", () => {
  it("is complete for a fully structured tier-A user", () => {
    const user: EvaluableUser = {
      structuredAddress: {
        cityId: "Karachi",
        areaId: "DHA",
        houseNo: "12-C",
      },
      locationVersion: 1,
    };

    const result = evaluateLocation(user);

    expect(result).toEqual({
      complete: true,
      missing: [],
      version: LOCATION_COMPLETION_VERSION,
      currentVersion: 1,
      bucket: "complete",
    });
  });

  it("reports missing houseNo and buckets as no_pin when no pin is present", () => {
    const user: EvaluableUser = {
      structuredAddress: {
        cityId: "Karachi",
        areaId: "DHA",
      },
    };

    const result = evaluateLocation(user);

    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["houseNo"]);
    expect(result.bucket).toBe("no_pin");
  });

  it("satisfies areaId from the legacy town/townOther pair on a legacy-only user", () => {
    const user: EvaluableUser = {
      city: "Karachi",
      town: "DHA",
    };

    const result = evaluateLocation(user);

    expect(result.missing).toEqual(["houseNo"]);
    expect(result.missing).not.toContain("areaId");
  });

  it("satisfies areaId via townOther when town is empty", () => {
    const user: EvaluableUser = {
      city: "Karachi",
      town: "",
      townOther: "Some custom area",
      structuredAddress: { houseNo: "44" },
    };

    const result = evaluateLocation(user);

    expect(result.missing).not.toContain("areaId");
    expect(result.complete).toBe(true);
  });
});

// Faisalabad: tier C (even though it has a towns list) -> falls back to the
// pin-based requirement set, and never demands areaId.
describe("evaluateLocation — tier C / unknown city falls back to pin", () => {
  it("requires cityId, houseNo, and pin — not areaId — for a tier-C city", () => {
    const user: EvaluableUser = {
      structuredAddress: { cityId: "Faisalabad", houseNo: "9" },
    };

    const result = evaluateLocation(user);

    expect(result.missing).toEqual(["pin"]);
    expect(result.missing).not.toContain("areaId");
  });

  it("requires cityId, houseNo, and pin — not areaId — for an unrecognized city string", () => {
    const user: EvaluableUser = {
      structuredAddress: { cityId: "Nonexistent City", houseNo: "9" },
    };

    const result = evaluateLocation(user);

    expect(result.missing).toEqual(["pin"]);
    expect(result.missing).not.toContain("areaId");
  });

  it("requires the tier-C set (missing starts at cityId) when there is no city at all", () => {
    const user: EvaluableUser = {};

    const result = evaluateLocation(user);

    expect(result.missing).toEqual(["cityId", "houseNo", "pin"]);
    expect(result.bucket).toBe("no_pin");
  });

  it("is complete when a valid map_pin is present alongside cityId and houseNo", () => {
    const user: EvaluableUser = {
      structuredAddress: { cityId: "Faisalabad", houseNo: "9" },
      location: { coordinates: [67.01, 24.86], source: "map_pin" },
    };

    const result = evaluateLocation(user);

    expect(result.complete).toBe(true);
    expect(result.bucket).toBe("complete");
  });
});

describe("evaluateLocation — pin field satisfaction", () => {
  const baseUser: EvaluableUser = {
    structuredAddress: { cityId: "Faisalabad", houseNo: "9" },
  };

  it("does NOT satisfy pin for an area_centroid source", () => {
    const user: EvaluableUser = {
      ...baseUser,
      location: { coordinates: [67.01, 24.86], source: "area_centroid" },
    };

    const result = evaluateLocation(user);

    expect(result.missing).toContain("pin");
    expect(result.bucket).toBe("no_pin");
  });

  it("does NOT satisfy pin for an empty coordinates array", () => {
    const user: EvaluableUser = {
      ...baseUser,
      location: { coordinates: [], source: "map_pin" },
    };

    const result = evaluateLocation(user);

    expect(result.missing).toContain("pin");
  });

  it("satisfies pin for a collector_verified source", () => {
    const user: EvaluableUser = {
      ...baseUser,
      location: { coordinates: [67.01, 24.86], source: "collector_verified" },
    };

    const result = evaluateLocation(user);

    expect(result.missing).not.toContain("pin");
    expect(result.complete).toBe(true);
  });

  it("buckets as has_pin_partial when the pin is valid but another field is missing", () => {
    const user: EvaluableUser = {
      structuredAddress: { cityId: "Faisalabad" },
      location: { coordinates: [67.01, 24.86], source: "map_pin" },
    };

    const result = evaluateLocation(user);

    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["houseNo"]);
    expect(result.bucket).toBe("has_pin_partial");
  });
});

describe("evaluateLocation — version echo", () => {
  it("echoes user.locationVersion as currentVersion", () => {
    expect(evaluateLocation({ locationVersion: 3 }).currentVersion).toBe(3);
  });

  it("defaults currentVersion to 0 when locationVersion is absent", () => {
    expect(evaluateLocation({}).currentVersion).toBe(0);
  });

  it("always reports the current LOCATION_COMPLETION_VERSION", () => {
    expect(evaluateLocation({}).version).toBe(LOCATION_COMPLETION_VERSION);
  });
});
