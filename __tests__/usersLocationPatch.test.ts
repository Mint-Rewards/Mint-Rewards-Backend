/**
 * P1.4 verification: PATCH /api/users/location, the progressive-save
 * endpoint.
 *
 * Reads the document back with the RAW DRIVER, never the endpoint's response
 * — same rationale as updateProfileLocation.test.ts: a field dropped by a
 * whole-subdocument assign (instead of the required dotted `$set` paths)
 * would be invisible in a response that only echoes evaluateLocation's
 * summary, not the persisted document.
 *
 * Runs against MONGODB_URI_TEST; jest.setup.js forces that and throws if it
 * is unset, so this can never touch the primary database.
 */
import mongoose from "mongoose";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";

const TEST_EMAIL = `p1-location-patch-probe-${Date.now()}@example.invalid`;
let userId: string;
// What the mocked auth resolves to for the NEXT request. Kept separate from
// `userId` (the real, persisted probe user, used for cleanup) so the 401
// test can blank out auth without disturbing the id afterAll needs.
let authUserId: string | null = null;

jest.mock("@/lib/auth", () => ({
  getAuthenticatedUserId: jest.fn(async () => authUserId),
}));

// Imported after the mock so the route picks up the mocked auth.
const { PATCH } = require("@/app/api/users/location/route");

const patch = (body: unknown) =>
  PATCH(
    new Request("http://localhost/api/users/location", {
      method: "PATCH",
      headers: {
        authorization: "test-token",
        "content-type": "application/json",
      },
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
    userName: "P1 Location Patch Probe",
    email: TEST_EMAIL,
    password: "irrelevant",
    mintId: `P1LOCPATCH${Date.now()}`,
  });
  userId = String(user._id);
  authUserId = userId;
});

// jest.teardown.js registers its own afterAll via setupFilesAfterEnv, which
// runs BEFORE this one and disconnects — so reconnect before cleaning up,
// then hand the connection back in the state the shared teardown expects.
afterAll(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI as string);
  }
  if (userId) await UserModel.deleteOne({ _id: userId });
  await mongoose.disconnect();
});

describe("PATCH /api/users/location", () => {
  it("401s when unauthenticated", async () => {
    authUserId = null;
    const res = await patch({ structuredAddress: { cityId: "Karachi" } });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
    authUserId = userId;
  });

  it("saves cityId alone and dual-writes city/province without touching other structuredAddress keys", async () => {
    const res = await patch({ structuredAddress: { cityId: "Karachi" } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.Status).toBe("Success");
    expect(json.evaluation).toBeDefined();

    const raw = await readRaw();
    expect(raw!.structuredAddress.cityId).toBe("Karachi");
    expect(raw!.structuredAddress.areaId).toBeUndefined();
    expect(raw!.structuredAddress.houseNo).toBeUndefined();
    expect(raw!.city).toBe("Karachi");
    expect(raw!.province).toBe("Sindh");
  });

  it("a second PATCH with areaId keeps cityId (sibling preservation) and dual-writes town", async () => {
    const res = await patch({ structuredAddress: { areaId: "DHA" } });
    expect(res.status).toBe(200);

    const raw = await readRaw();
    expect(raw!.structuredAddress.cityId).toBe("Karachi");
    expect(raw!.structuredAddress.areaId).toBe("DHA");
    expect(raw!.town).toBe("DHA");
    expect(raw!.townOther).toBe("");
  });

  it("dual-writes blockId -> subArea and clears subAreaOther", async () => {
    const res = await patch({ structuredAddress: { blockId: "Phase 6" } });
    expect(res.status).toBe(200);

    const raw = await readRaw();
    expect(raw!.structuredAddress.blockId).toBe("Phase 6");
    expect(raw!.subArea).toBe("Phase 6");
    expect(raw!.subAreaOther).toBe("");
    // Sibling from the previous PATCH must survive.
    expect(raw!.structuredAddress.areaId).toBe("DHA");
  });

  // IMPORTANT-4: structuredAddress.areaId and structuredAddress.areaOther are
  // mutually exclusive (models.ts's doc comment on `structuredAddress`),
  // mirroring the legacy town/townOther pair's semantics exactly — writing
  // one must clear the other, not just the legacy dual-write.
  it("writing areaOther clears structuredAddress.areaId, and satisfies the areaId requirement (previously untested path)", async () => {
    // Entering this test, the prior test left structuredAddress.areaId="DHA".
    const res = await patch({
      structuredAddress: { areaOther: "My Custom Colony" },
    });
    expect(res.status).toBe(200);
    const json = await res.json();

    const raw = await readRaw();
    expect(raw!.structuredAddress.areaOther).toBe("My Custom Colony");
    expect(raw!.structuredAddress.areaId).toBe("");
    // Legacy dual-write pair, unaffected by this fix — asserted for parity.
    expect(raw!.townOther).toBe("My Custom Colony");
    expect(raw!.town).toBe("");
    // cityId is still Karachi from the very first PATCH in this suite, so
    // the only thing evaluateLocation should still be missing is houseNo —
    // never areaId, since structuredAddress.areaOther alone satisfies it.
    expect(json.evaluation.missing).not.toContain("areaId");
    expect(json.evaluation.missing).toEqual(["houseNo"]);
  });

  it("writing areaId back clears structuredAddress.areaOther", async () => {
    const res = await patch({ structuredAddress: { areaId: "Clifton" } });
    expect(res.status).toBe(200);

    const raw = await readRaw();
    expect(raw!.structuredAddress.areaId).toBe("Clifton");
    expect(raw!.structuredAddress.areaOther).toBe("");
    expect(raw!.town).toBe("Clifton");
    expect(raw!.townOther).toBe("");
  });

  it("writing blockOther clears structuredAddress.blockId", async () => {
    // Entering this test, an earlier test left structuredAddress.blockId="Phase 6".
    const res = await patch({
      structuredAddress: { blockOther: "Custom Block 9" },
    });
    expect(res.status).toBe(200);

    const raw = await readRaw();
    expect(raw!.structuredAddress.blockOther).toBe("Custom Block 9");
    expect(raw!.structuredAddress.blockId).toBe("");
    expect(raw!.subAreaOther).toBe("Custom Block 9");
    expect(raw!.subArea).toBe("");
  });

  it("writing blockId back clears structuredAddress.blockOther", async () => {
    const res = await patch({ structuredAddress: { blockId: "Phase 8" } });
    expect(res.status).toBe(200);

    const raw = await readRaw();
    expect(raw!.structuredAddress.blockId).toBe("Phase 8");
    expect(raw!.structuredAddress.blockOther).toBe("");
    expect(raw!.subArea).toBe("Phase 8");
    expect(raw!.subAreaOther).toBe("");
    // Sibling from the areaId/areaOther pair above must survive untouched.
    expect(raw!.structuredAddress.areaId).toBe("Clifton");
  });

  it("saves a coordinate pair, dual-writes latitude/longitude, and sets type/capturedAt", async () => {
    const res = await patch({
      location: {
        coordinates: [67.0011, 24.8607],
        source: "map_pin",
        precision: "building",
        accuracyMeters: 8,
      },
    });
    expect(res.status).toBe(200);

    const raw = await readRaw();
    expect(raw!.location.coordinates).toEqual([67.0011, 24.8607]);
    expect(raw!.location.type).toBe("Point");
    expect(raw!.location.source).toBe("map_pin");
    expect(raw!.location.precision).toBe("building");
    expect(raw!.location.accuracyMeters).toBe(8);
    expect(raw!.location.capturedAt).toBeInstanceOf(Date);
    // Human order: latitude first.
    expect(raw!.latitude).toBe("24.8607");
    expect(raw!.longitude).toBe("67.0011");
  });

  it("rejects bad coordinates with 400 and writes nothing", async () => {
    const before = await readRaw();
    const res = await patch({ location: { coordinates: [200, 91] } });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe("string");

    const after = await readRaw();
    expect(after!.location.coordinates).toEqual(before!.location.coordinates);
    expect(after!.location.capturedAt).toEqual(before!.location.capturedAt);
  });

  it("rejects a malformed coordinates array with 400 and writes nothing", async () => {
    const before = await readRaw();
    const res = await patch({
      location: { coordinates: ["not-a-number", 24.86] },
    });
    expect(res.status).toBe(400);

    const after = await readRaw();
    expect(after!.location.coordinates).toEqual(before!.location.coordinates);
  });

  it("rejects an unrecognized location.source with 400 and writes nothing", async () => {
    const before = await readRaw();
    const res = await patch({ location: { source: "gps_guess" } });
    expect(res.status).toBe(400);

    const after = await readRaw();
    expect(after!.location.source).toBe(before!.location.source);
  });

  it("rejects an over-length string leaf with 400", async () => {
    const res = await patch({
      structuredAddress: { houseNo: "x".repeat(201) },
    });
    expect(res.status).toBe(400);
  });

  it("ignores unknown keys", async () => {
    const before = await readRaw();
    const res = await patch({
      structuredAddress: { cityId: "Karachi", notARealField: "nope" },
    });
    expect(res.status).toBe(200);

    const after = await readRaw();
    expect(after!.structuredAddress.notARealField).toBeUndefined();
    // cityId re-saved with the same value; unrelated fields unaffected.
    expect(after!.structuredAddress.areaId).toBe(
      before!.structuredAddress.areaId,
    );
  });

  it("completes the location requirement exactly once", async () => {
    // Fresh probe user isolated to this test, so evaluateLocation's
    // requirement set (Karachi/DHA is tier A + hasTowns => cityId/areaId/houseNo)
    // starts from a clean slate.
    const completingUser = await UserModel.create({
      userName: "P1 Location Completion Probe",
      email: `p1-location-complete-${Date.now()}@example.invalid`,
      password: "irrelevant",
      mintId: `P1LOCCOMPLETE${Date.now()}`,
    });
    const completingUserId = String(completingUser._id);
    const originalAuthUserId = authUserId;
    authUserId = completingUserId;
    // readRaw() below reads by `userId`, so point it at the completing user
    // for the duration of this test.
    const originalUserId = userId;
    userId = completingUserId;

    try {
      const res = await patch({
        structuredAddress: {
          cityId: "Karachi",
          areaId: "DHA",
          houseNo: "12-C",
        },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.evaluation.complete).toBe(true);
      // IMPORTANT-5: the completion bump fires in this same request, so the
      // RESPONSE's evaluation must already reflect the post-bump version —
      // not the pre-bump `user.locationVersion` the evaluation was computed
      // from before the bump ran.
      expect(json.evaluation.currentVersion).toBe(json.evaluation.version);
      expect(json.evaluation.currentVersion).toBe(1);

      const raw = await readRaw();
      expect(raw!.locationVersion).toBe(1);
      expect(raw!.locationCompletedAt).toBeInstanceOf(Date);
      const firstCompletedAt = raw!.locationCompletedAt as Date;

      // Repeat PATCH: still complete, but locationCompletedAt must not move.
      const res2 = await patch({ structuredAddress: { houseNo: "12-C" } });
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.evaluation.complete).toBe(true);

      const raw2 = await readRaw();
      expect(raw2!.locationVersion).toBe(1);
      expect((raw2!.locationCompletedAt as Date).getTime()).toBe(
        firstCompletedAt.getTime(),
      );
    } finally {
      userId = originalUserId;
      authUserId = originalAuthUserId;
      await UserModel.deleteOne({ _id: completingUserId });
    }
  });
});
