/// <reference types="jest" />

/**
 * P1.1 verification: POST /api/location/reverse-geocode.
 *
 * `global.fetch` is always mocked — this suite never hits the real LocationIQ
 * API. `LOCATIONIQ_API_KEY` is injected via a getter override on the mocked
 * `serverEnv` (the resendWebhook.test.ts pattern, extended: that suite fixes
 * one value for the whole file, this one needs to flip a single test to the
 * "key unset" case without disturbing every other property `serverEnv`
 * carries — notably `mongodbUri`, which lib/mongodb.ts needs for the real
 * connection this suite uses to verify the cache document via the raw
 * driver).
 *
 * Cache reads/writes are verified with the RAW DRIVER against the
 * `geocodeCache` collection, per the P1.1 brief and the pattern in
 * __tests__/updateProfileLocation.test.ts — the route's own response is not
 * proof of what got persisted.
 */
import mongoose from "mongoose";

let mockApiKey: string | null = "test-locationiq-key";

jest.mock("../lib/env", () => {
  const actual = jest.requireActual("../lib/env");
  const mockedServerEnv = { ...actual.serverEnv };
  Object.defineProperty(mockedServerEnv, "locationIqApiKey", {
    enumerable: true,
    get: () => mockApiKey,
  });
  return { ...actual, serverEnv: mockedServerEnv };
});

let authUserId: string | null = "reverse-geocode-test-user";
jest.mock("../lib/auth", () => ({
  getAuthenticatedUserId: jest.fn(async () => authUserId),
}));

let rateLimited = false;
jest.mock("../lib/rateLimit", () => {
  const actual = jest.requireActual("../lib/rateLimit");
  return {
    ...actual,
    checkRateLimit: jest.fn(async () =>
      rateLimited
        ? { limited: true, retryAfterSeconds: 42 }
        : { limited: false, retryAfterSeconds: 0 },
    ),
  };
});

import connectToDatabase from "../lib/mongodb";
import { geocodeCacheKey } from "../lib/geocodeCache";
import registryArtifact from "../lib/data/locationRegistry.json";

// Imported after the mocks so the route picks up the mocked env/auth/rateLimit.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST } = require("../app/api/location/reverse-geocode/route");

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/location/reverse-geocode", {
      method: "POST",
      headers: {
        authorization: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

interface RawGeocodeCacheDoc {
  _id: string;
  raw: Record<string, unknown>;
  cityName: string | null;
  areaName: string | null;
  blockHint: string | null;
  resolvedAt: Date;
}

/** Raw driver read — deliberately bypasses Mongoose and the endpoint echo. */
const readRawCache = async (key: string) => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  return db
    .collection<RawGeocodeCacheDoc>("geocodeCache")
    .findOne({ _id: key });
};

const HAPPY_LAT = 24.861;
const HAPPY_LNG = 67.011;
const REJECT_LAT = 24.862;
const REJECT_LNG = 67.012;
const UNMATCHED_LAT = 24.863;
const UNMATCHED_LNG = 67.013;
const RATE_LIMIT_LAT = 24.864;
const RATE_LIMIT_LNG = 67.014;

/** Real LocationIQ payloads from DHA Karachi — see the DIVISION_* tests. */
const DIVISION_LAT = 24.814634;
const DIVISION_LNG = 67.080003;
const DIVISION_UNKNOWN_LAT = 24.814;
const DIVISION_UNKNOWN_LNG = 67.081;
const LANG_LAT = 24.815;
const LANG_LNG = 67.082;

const cacheKeysToClean = [
  geocodeCacheKey(HAPPY_LAT, HAPPY_LNG),
  geocodeCacheKey(REJECT_LAT, REJECT_LNG),
  geocodeCacheKey(UNMATCHED_LAT, UNMATCHED_LNG),
  geocodeCacheKey(RATE_LIMIT_LAT, RATE_LIMIT_LNG),
  geocodeCacheKey(DIVISION_LAT, DIVISION_LNG),
  geocodeCacheKey(DIVISION_UNKNOWN_LAT, DIVISION_UNKNOWN_LNG),
  geocodeCacheKey(LANG_LAT, LANG_LNG),
];

let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeAll(async () => {
  await connectToDatabase();
});

beforeEach(() => {
  // Bare jest.spyOn() calls through to the real implementation by default —
  // rejecting here means every test that never overrides this is a hard
  // failure (not a silent real network call) the moment it reaches fetch.
  fetchMock = jest
    .spyOn(global, "fetch")
    .mockRejectedValue(new Error("unexpected real fetch call in test"));
});

afterEach(() => {
  mockApiKey = "test-locationiq-key";
  authUserId = "reverse-geocode-test-user";
  rateLimited = false;
  jest.restoreAllMocks();
});

afterAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI as string);
  }
  const db = mongoose.connection.db;
  if (db) {
    await db
      .collection<RawGeocodeCacheDoc>("geocodeCache")
      .deleteMany({ _id: { $in: cacheKeysToClean } });
  }
  await mongoose.disconnect();
});

describe("POST /api/location/reverse-geocode", () => {
  it("asks LocationIQ for English, which undici does not do by default", async () => {
    // Node's fetch sends `Accept-Language: *` when nothing is set, and
    // LocationIQ reads `*` as "return the NATIVE name" — so every Karachi
    // lookup came back in Urdu ("کراچی ڈویژن", "ضلع کراچی") and could not
    // match a Latin-script registry. Nothing resolved, anywhere, and it looked
    // exactly like a coverage problem. Pinned in the header AND the query so
    // neither can be dropped silently.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        address: { city: "Karachi", suburb: "Gulshan-e-Iqbal" },
      }),
    } as Response);

    await post({ lat: LANG_LAT, lng: LANG_LNG });

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("accept-language=en");
    expect((init.headers as Record<string, string>)["Accept-Language"]).toBe(
      "en",
    );
  });

  it("resolves DHA when LocationIQ names the city 'Karachi Division'", async () => {
    // NOT a synthetic payload: this is verbatim what LocationIQ answers at the
    // DHA centroid. `city` is the DIVISION, and "Defence" is a curated DHA
    // alias that resolves under "Karachi" and to null under "Karachi Division".
    // Before the city was normalized, every area in Karachi failed this way and
    // the town never prefilled anywhere in the city.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        address: {
          city: "Karachi Division",
          suburb: "Defence",
        },
      }),
    } as Response);

    const res = await post({ lat: DIVISION_LAT, lng: DIVISION_LNG });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.cityName).toBe("Karachi");
    expect(json.areaName).toBe("DHA");
    expect(json.resolved).toBe(true);
  });

  it("leaves a city it cannot map alone, so the unmatched signal survives", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        address: {
          // Stripping the suffix does not produce a registry city either, so
          // the original string must come through untouched and still be
          // logged — normalization must not paper over a genuine gap.
          city: "Atlantis Division",
          suburb: "Gulshan-e-Iqbal",
        },
      }),
    } as Response);

    const res = await post({
      lat: DIVISION_UNKNOWN_LAT,
      lng: DIVISION_UNKNOWN_LNG,
    });
    const json = await res.json();

    expect(json.cityName).toBe("Atlantis Division");
    expect(warnSpy).toHaveBeenCalledWith(
      `[geocode-unmatched-city] ${JSON.stringify("Atlantis Division")}`,
    );
    warnSpy.mockRestore();
  });

  it("no registry city ends in an admin suffix, so stripping cannot collide", () => {
    // The safety argument for CITY_ADMIN_SUFFIXES, asserted rather than
    // assumed: a strip can only turn a non-city into a city, never one city
    // into a different one.
    const cities = Object.keys(registryArtifact.cities);
    expect(
      cities.filter((c) => /\s+(Division|District|Tehsil)$/i.test(c)),
    ).toEqual([]);
  });

  it("resolves a suburb to its registry town and writes the cache document", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        address: {
          city: "Karachi",
          suburb: "Gulshan-e-Iqbal",
          neighbourhood: "Block 13",
        },
      }),
    } as Response);

    const res = await post({ lat: HAPPY_LAT, lng: HAPPY_LNG });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json).toEqual({
      resolved: true,
      cityName: "Karachi",
      areaName: "Gulshan-e-Iqbal",
      blockHint: "Block 13",
      raw: {
        city: "Karachi",
        suburb: "Gulshan-e-Iqbal",
        neighbourhood: "Block 13",
      },
      unmatched: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The key never appears in the response body.
    expect(JSON.stringify(json)).not.toContain("test-locationiq-key");

    const doc = await readRawCache(geocodeCacheKey(HAPPY_LAT, HAPPY_LNG));
    expect(doc).toMatchObject({
      cityName: "Karachi",
      areaName: "Gulshan-e-Iqbal",
      blockHint: "Block 13",
    });
    expect(doc!.resolvedAt).toBeInstanceOf(Date);
  });

  it("serves the second identical call from cache without calling fetch", async () => {
    const res = await post({ lat: HAPPY_LAT, lng: HAPPY_LNG });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json).toEqual({
      resolved: true,
      cityName: "Karachi",
      areaName: "Gulshan-e-Iqbal",
      blockHint: "Block 13",
      raw: {
        city: "Karachi",
        suburb: "Gulshan-e-Iqbal",
        neighbourhood: "Block 13",
      },
      unmatched: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns resolved:false and caches nothing on a fetch rejection", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const res = await post({ lat: REJECT_LAT, lng: REJECT_LNG });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.resolved).toBe(false);

    const doc = await readRawCache(geocodeCacheKey(REJECT_LAT, REJECT_LNG));
    expect(doc).toBeNull();
  });

  it("returns resolved:false without calling fetch when the API key is unset", async () => {
    mockApiKey = null;

    const res = await post({ lat: 24.87, lng: 67.02 });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      resolved: false,
      cityName: null,
      areaName: null,
      blockHint: null,
      raw: null,
      unmatched: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s on out-of-range coordinates", async () => {
    const res = await post({ lat: 91, lng: 67.0 });
    expect(res.status).toBe(400);

    const res2 = await post({ lat: 24.8, lng: 181 });
    expect(res2.status).toBe(400);
  });

  it("resolves via city_district when suburb is unmatched, listing the suburb as unmatched", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        address: {
          city: "Karachi",
          suburb: "Not A Real Suburb XYZ",
          city_district: "Gulshan-e-Iqbal",
        },
      }),
    } as Response);

    const res = await post({ lat: UNMATCHED_LAT, lng: UNMATCHED_LNG });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.resolved).toBe(true);
    expect(json.areaName).toBe("Gulshan-e-Iqbal");
    expect(json.unmatched).toEqual(["Not A Real Suburb XYZ"]);
    // MINOR-5: the interpolated third-party string is JSON.stringify'd, so an
    // embedded quote or control character in a LocationIQ suburb string can
    // never break the log line's own structure.
    expect(warnSpy).toHaveBeenCalledWith(
      `[geocode-unmatched] ${JSON.stringify("Not A Real Suburb XYZ")}`,
    );

    warnSpy.mockRestore();
  });

  it("resolves via a lowercase city string (IMPORTANT-2 fold tolerance)", async () => {
    const LOWERCASE_CITY_LAT = 24.865;
    const LOWERCASE_CITY_LNG = 67.015;
    cacheKeysToClean.push(
      geocodeCacheKey(LOWERCASE_CITY_LAT, LOWERCASE_CITY_LNG),
    );

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        address: {
          city: "karachi",
          suburb: "Gulshan-e-Iqbal",
        },
      }),
    } as Response);

    const res = await post({
      lat: LOWERCASE_CITY_LAT,
      lng: LOWERCASE_CITY_LNG,
    });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.resolved).toBe(true);
    expect(json.cityName).toBe("karachi");
    expect(json.areaName).toBe("Gulshan-e-Iqbal");
  });

  it("logs [geocode-unmatched-city] and still continues when cityName resolves to no known city", async () => {
    const UNKNOWN_CITY_LAT = 24.866;
    const UNKNOWN_CITY_LNG = 67.016;
    cacheKeysToClean.push(geocodeCacheKey(UNKNOWN_CITY_LAT, UNKNOWN_CITY_LNG));

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        address: {
          city: "Not A Real City XYZ",
          suburb: "Gulshan-e-Iqbal",
        },
      }),
    } as Response);

    const res = await post({ lat: UNKNOWN_CITY_LAT, lng: UNKNOWN_CITY_LNG });
    expect(res.status).toBe(200);
    const json = await res.json();

    // The route still runs to completion — an unknown city does not abort
    // the request, it just means the area lookup is effectively unscoped.
    expect(json.cityName).toBe("Not A Real City XYZ");
    expect(warnSpy).toHaveBeenCalledWith(
      `[geocode-unmatched-city] ${JSON.stringify("Not A Real City XYZ")}`,
    );

    warnSpy.mockRestore();
  });

  it("429s when the rate limit is exceeded", async () => {
    rateLimited = true;

    const res = await post({ lat: RATE_LIMIT_LAT, lng: RATE_LIMIT_LNG });
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    authUserId = null;
    const res = await post({ lat: HAPPY_LAT, lng: HAPPY_LNG });
    expect(res.status).toBe(401);
  });
});
