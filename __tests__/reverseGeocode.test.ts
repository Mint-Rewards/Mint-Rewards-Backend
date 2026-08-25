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

// Imported after the mocks so the route picks up the mocked env/auth/rateLimit.
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

const cacheKeysToClean = [
  geocodeCacheKey(HAPPY_LAT, HAPPY_LNG),
  geocodeCacheKey(REJECT_LAT, REJECT_LNG),
  geocodeCacheKey(UNMATCHED_LAT, UNMATCHED_LNG),
  geocodeCacheKey(RATE_LIMIT_LAT, RATE_LIMIT_LNG),
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
