/**
 * P0.3 verification: the structured-location fields actually persist.
 *
 * This test reads the document back with the RAW DRIVER, never the endpoint's
 * response. That distinction is the whole point. `update-profile` returns the
 * Mongoose document it just wrote, so a field dropped by one of the route's two
 * allowlists is invisible in the response — the endpoint answers 200 with a
 * value that was never stored. Only a direct read can tell the difference.
 *
 * Runs against MONGODB_URI_TEST; jest.setup.js forces that and throws if it is
 * unset, so this can never touch the primary database.
 */
import mongoose from "mongoose";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";

const TEST_EMAIL = `p0-location-probe-${Date.now()}@example.invalid`;
let userId: string;

jest.mock("@/lib/auth", () => ({
  getAuthenticatedUserId: jest.fn(async () => userId),
}));

// Imported after the mock so the route picks up the mocked auth.
const { PUT } = require("@/app/api/users/update-profile/route");

const put = (body: unknown) =>
  PUT(
    new Request("http://localhost/api/users/update-profile", {
      method: "PUT",
      headers: { authorization: "test-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** Raw driver read — deliberately bypasses Mongoose and the endpoint echo. */
const readRaw = async () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  return db
    .collection("users")
    .findOne({ _id: new mongoose.Types.ObjectId(userId) });
};

beforeAll(async () => {
  await connectToDatabase();
  const user = await UserModel.create({
    userName: "P0 Location Probe",
    email: TEST_EMAIL,
    password: "irrelevant",
    mintId: `P0PROBE${Date.now()}`,
  });
  userId = String(user._id);
});

// jest.teardown.js registers its own afterAll via setupFilesAfterEnv, which
// runs BEFORE this one and disconnects — so reconnect before cleaning up, then
// hand the connection back in the state the shared teardown expects. Without
// this the probe user survives every run and accumulates in the test database.
afterAll(async () => {
  // Not connectToDatabase(): it memoises its connection promise, so after a
  // disconnect it hands back a dead connection rather than opening a new one.
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI as string);
  }
  if (userId) await UserModel.deleteOne({ _id: userId });
  await mongoose.disconnect();
});

describe("PUT /api/users/update-profile — structured location", () => {
  it("persists every new field to the database", async () => {
    const res = await put({
      location: {
        lat: 24.8607,
        lng: 67.0011,
        source: "map_pin",
        precision: "building",
        accuracyMeters: 12,
      },
      structuredAddress: {
        cityId: "Karachi",
        areaId: "Gulshan-e-Iqbal",
        blockId: "Block 13",
        houseNo: "A-42",
        streetOrBlock: "Street 5",
      },
      locationVerification: {
        status: "user_corrected",
        method: "reverse_geocode",
        geocodedAreaRaw: "Gulshan Town",
        geocodedAreaId: "Gulshan-e-Iqbal",
        selectedAreaId: "Gulshan-e-Iqbal",
        distanceMeters: 140,
      },
    });
    expect(res.status).toBe(200);

    const doc = await readRaw();

    // GeoJSON order is [lng, lat] — the reverse of how the legacy pair reads.
    expect(doc!.location.coordinates).toEqual([67.0011, 24.8607]);
    expect(doc!.location.type).toBe("Point");
    expect(doc!.location.source).toBe("map_pin");
    expect(doc!.location.precision).toBe("building");
    expect(doc!.location.accuracyMeters).toBe(12);
    expect(doc!.location.capturedAt).toBeInstanceOf(Date);

    expect(doc!.structuredAddress).toMatchObject({
      cityId: "Karachi",
      areaId: "Gulshan-e-Iqbal",
      blockId: "Block 13",
      houseNo: "A-42",
      streetOrBlock: "Street 5",
    });

    expect(doc!.locationVerification).toMatchObject({
      status: "user_corrected",
      geocodedAreaRaw: "Gulshan Town",
      selectedAreaId: "Gulshan-e-Iqbal",
      distanceMeters: 140,
    });
  });

  it("dual-writes the legacy latitude/longitude strings", async () => {
    const doc = await readRaw();
    expect(doc!.latitude).toBe("24.8607");
    expect(doc!.longitude).toBe("67.0011");
  });

  // The failure mode dotted paths exist to prevent.
  it("does not wipe sibling keys on a partial update", async () => {
    await put({ structuredAddress: { houseNo: "B-7" } });

    const doc = await readRaw();
    expect(doc!.structuredAddress.houseNo).toBe("B-7");
    // These were not in the second request and must survive it.
    expect(doc!.structuredAddress.cityId).toBe("Karachi");
    expect(doc!.structuredAddress.areaId).toBe("Gulshan-e-Iqbal");
    expect(doc!.location.source).toBe("map_pin");
    expect(doc!.location.capturedAt).toBeInstanceOf(Date);
  });

  it("keeps an explicitly supplied legacy coordinate over the derived one", async () => {
    await put({
      latitude: "11.1111",
      longitude: "22.2222",
      location: { lat: 24.9, lng: 67.1, source: "map_pin", precision: "building" },
    });
    const doc = await readRaw();
    expect(doc!.latitude).toBe("11.1111");
    expect(doc!.longitude).toBe("22.2222");
    expect(doc!.location.coordinates).toEqual([67.1, 24.9]);
  });

  // A bad pin must not fail the whole save, or a malformed coordinate would
  // block the user from completing onboarding at all.
  it("ignores an unusable coordinate without failing the request", async () => {
    const before = await readRaw();
    const res = await put({
      userName: "Still Saved",
      location: { lat: "not-a-number", lng: 67.0 },
    });
    expect(res.status).toBe(200);

    const doc = await readRaw();
    expect(doc!.userName).toBe("Still Saved");
    expect(doc!.location.coordinates).toEqual(before!.location.coordinates);
  });

  it("rejects out-of-range coordinates", async () => {
    const before = await readRaw();
    await put({ location: { lat: 91, lng: 200, source: "map_pin" } });
    const doc = await readRaw();
    expect(doc!.location.coordinates).toEqual(before!.location.coordinates);
  });
});
