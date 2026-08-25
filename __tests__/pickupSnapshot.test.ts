/**
 * P0.4a: pickup records snapshot the user's address at creation.
 *
 * `pickupHistory` entries previously referenced only the live User document,
 * so every historical pickup silently re-pointed when the user edited their
 * address. The snapshot is written once at creation and never re-derived.
 *
 * No pickup-creation endpoint exists in this repo yet — the writer lives in
 * the collector system. These tests pin the two things this repo owns: the
 * snapshot builder every writer must call, and the schema that persists it.
 *
 * Persistence is verified with the RAW DRIVER, not the Mongoose echo, for the
 * same reason as updateProfileLocation.test.ts.
 */
import mongoose from "mongoose";
import connectToDatabase from "@/lib/mongodb";
import { UserModel } from "@/lib/models";
import { buildPickupAddressSnapshot } from "@/lib/pickupSnapshot";

const TEST_EMAIL = `p04a-pickup-snapshot-${Date.now()}@example.invalid`;

const fullUser = {
  address: "House 12, Street 4",
  province: "Sindh",
  city: "Karachi",
  town: "Korangi",
  townOther: "",
  subArea: "Sector 31",
  subAreaOther: "",
  latitude: "24.8300",
  longitude: "67.1200",
  structuredAddress: {
    cityId: "Karachi",
    areaId: "Korangi",
    blockId: "Sector 31",
    houseNo: "12",
    streetOrBlock: "Street 4",
  },
  location: {
    type: "Point" as const,
    coordinates: [67.12, 24.83],
    source: "map_pin" as const,
    precision: "building" as const,
    accuracyMeters: 8,
    capturedAt: new Date("2026-08-01T00:00:00Z"),
  },
};

describe("buildPickupAddressSnapshot", () => {
  it("copies legacy strings, structuredAddress and location, and stamps provenance", () => {
    const snap = buildPickupAddressSnapshot(fullUser);
    expect(snap.address).toBe("House 12, Street 4");
    expect(snap.city).toBe("Karachi");
    expect(snap.town).toBe("Korangi");
    expect(snap.subArea).toBe("Sector 31");
    expect(snap.structuredAddress).toEqual(fullUser.structuredAddress);
    expect(snap.location).toEqual(fullUser.location);
    // A copy, not a reference to the live subdocuments.
    expect(snap.structuredAddress).not.toBe(fullUser.structuredAddress);
    expect(snap.location).not.toBe(fullUser.location);
    expect(snap.snapshotSource).toBe("creation");
    expect(snap.snapshotAt).toBeInstanceOf(Date);
  });

  it("derives location from parseable legacy latitude/longitude when no GeoJSON exists", () => {
    const snap = buildPickupAddressSnapshot({
      ...fullUser,
      location: undefined,
    });
    expect(snap.location).toEqual({
      type: "Point",
      // [lng, lat] — GeoJSON order.
      coordinates: [67.12, 24.83],
      source: "legacy_string",
      precision: "unknown",
    });
  });

  it("omits location entirely when coordinates are empty or unparseable", () => {
    for (const [latitude, longitude] of [
      ["", ""],
      ["abc", "67.1"],
      ["24.8", ""],
    ]) {
      const snap = buildPickupAddressSnapshot({
        ...fullUser,
        location: undefined,
        latitude,
        longitude,
      });
      expect(snap.location).toBeUndefined();
    }
  });

  it("omits a GeoJSON location whose coordinates array is empty", () => {
    const snap = buildPickupAddressSnapshot({
      ...fullUser,
      location: { type: "Point", coordinates: [] },
      latitude: "",
      longitude: "",
    });
    expect(snap.location).toBeUndefined();
  });
});

describe("pickupHistory.addressSnapshot persistence", () => {
  let userId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    await connectToDatabase();
    const user = await UserModel.create({
      userName: "P04a Probe",
      email: TEST_EMAIL,
      password: "irrelevant-hash",
      mintId: `p04a-${Date.now()}`,
      ...fullUser,
    });
    userId = user._id as mongoose.Types.ObjectId;
  });

  afterAll(async () => {
    await UserModel.deleteOne({ _id: userId });
    await mongoose.connection.close();
  });

  const readRaw = async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error("not connected");
    return db.collection("users").findOne({ _id: userId });
  };

  it("persists the snapshot on a pickup entry and leaves snapshot-less entries valid", async () => {
    const user = await UserModel.findById(userId);
    if (!user) throw new Error("probe user missing");

    const snapshot = buildPickupAddressSnapshot(user);
    user.pickupHistory.push(
      // Legacy-shaped entry with no snapshot — must remain valid.
      {
        collectionId: new mongoose.Types.ObjectId(),
        collectionName: "Legacy Collection",
        captain: new mongoose.Types.ObjectId(),
        status: "COMPLETED",
      } as never,
      {
        collectionId: new mongoose.Types.ObjectId(),
        collectionName: "Snapshotted Collection",
        captain: new mongoose.Types.ObjectId(),
        status: "SCHEDULED",
        addressSnapshot: snapshot,
      } as never,
    );
    await user.save();

    const raw = await readRaw();
    expect(raw).not.toBeNull();
    const [legacy, snapped] = raw!.pickupHistory;

    expect(legacy.addressSnapshot).toBeUndefined();

    expect(snapped.addressSnapshot).toBeDefined();
    expect(snapped.addressSnapshot.city).toBe("Karachi");
    expect(snapped.addressSnapshot.town).toBe("Korangi");
    expect(snapped.addressSnapshot.address).toBe("House 12, Street 4");
    expect(snapped.addressSnapshot.structuredAddress.areaId).toBe("Korangi");
    expect(snapped.addressSnapshot.structuredAddress.houseNo).toBe("12");
    expect(snapped.addressSnapshot.location.coordinates).toEqual([67.12, 24.83]);
    expect(snapped.addressSnapshot.location.source).toBe("map_pin");
    expect(snapped.addressSnapshot.location.precision).toBe("building");
    expect(snapped.addressSnapshot.snapshotSource).toBe("creation");
    expect(snapped.addressSnapshot.snapshotAt).toBeInstanceOf(Date);
  });

  it("does not re-point the snapshot when the user's address later changes", async () => {
    await UserModel.updateOne(
      { _id: userId },
      { $set: { town: "Landhi", "structuredAddress.areaId": "Landhi" } },
    );
    const raw = await readRaw();
    const snapped = raw!.pickupHistory[1];
    expect(snapped.addressSnapshot.town).toBe("Korangi");
    expect(snapped.addressSnapshot.structuredAddress.areaId).toBe("Korangi");
  });
});
