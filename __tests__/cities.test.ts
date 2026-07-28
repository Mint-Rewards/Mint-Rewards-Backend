/// <reference types="jest" />

import { TARGETABLE_CITIES, InvalidCityError, parseTargetCities } from "../lib/cities";

describe("TARGETABLE_CITIES", () => {
  it("is the fixed 7-city list", () => {
    expect(TARGETABLE_CITIES).toEqual([
      "Karachi",
      "Lahore",
      "Islamabad",
      "Faisalabad",
      "Rawalpindi",
      "Multan",
      "Hyderabad",
    ]);
  });
});

describe("parseTargetCities", () => {
  it("returns [] for undefined, null, and empty string", () => {
    expect(parseTargetCities(undefined)).toEqual([]);
    expect(parseTargetCities(null)).toEqual([]);
    expect(parseTargetCities("")).toEqual([]);
  });

  it("accepts a JSON array of valid city names", () => {
    expect(parseTargetCities(["Lahore", "Karachi"])).toEqual(["Lahore", "Karachi"]);
  });

  it("accepts a comma-separated string (multipart/form-data case)", () => {
    expect(parseTargetCities("Lahore, Karachi")).toEqual(["Lahore", "Karachi"]);
  });

  it("trims whitespace and dedupes", () => {
    expect(parseTargetCities([" Lahore ", "Lahore", "Karachi"])).toEqual([
      "Lahore",
      "Karachi",
    ]);
  });

  it("throws InvalidCityError listing every invalid value", () => {
    expect(() => parseTargetCities(["Lahore", "Peshawar", "Quetta"])).toThrow(
      InvalidCityError,
    );
    try {
      parseTargetCities(["Lahore", "Peshawar", "Quetta"]);
      throw new Error("expected parseTargetCities to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCityError);
      expect((err as InvalidCityError).invalidValues).toEqual(["Peshawar", "Quetta"]);
    }
  });

  it("is case-sensitive against the fixed list", () => {
    expect(() => parseTargetCities(["lahore"])).toThrow(InvalidCityError);
  });

  it("throws InvalidCityError for malformed (non-array, non-string) input instead of silently clearing", () => {
    expect(() => parseTargetCities(123)).toThrow(InvalidCityError);
    expect(() => parseTargetCities({ foo: "bar" })).toThrow(InvalidCityError);
  });
});
