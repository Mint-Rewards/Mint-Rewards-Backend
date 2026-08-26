/**
 * The profile-completion bonus end to end, through the REAL route handlers.
 *
 * __tests__/profileBonus.test.ts covers the payout helper in isolation. This
 * file covers the thing that helper is useless without: that the app's actual
 * request sequence — cold start, then the two saves Edit Profile fires — opens
 * a window, pays exactly once, and leaves everything else alone.
 *
 * Documents are read back with the RAW DRIVER, following the house rule set by
 * usersLocationPatch.test.ts: my-profile echoes a Mongoose document that has
 * been decorated in memory, so asserting on the response would happily pass
 * while nothing was persisted.
 */

import mongoose from "mongoose";

// Mutable config, same technique and rationale as __tests__/profileBonus.test.ts.
const bonusConfig = {
  enabled: true,
  points: 100,
  windowHours: 24,
  campaignStart: null as string | null,
  campaignEnd: null as string | null,
};

jest.mock("../lib/env", () => {
  const actual = jest.requireActual("../lib/env");
  return {
    ...actual,
    serverEnv: {
      ...actual.serverEnv,
      appConfig: { ...actual.serverEnv.appConfig, profileBonus: bonusConfig },
    },
  };
});

let authUserId: string | null = null;
jest.mock("../lib/auth", () => ({
  getAuthenticatedUserId: jest.fn(async () => authUserId),
  checkAuth: jest.fn(async () => authUserId),
}));

import connectToDatabase from "../lib/mongodb";
import { UserModel } from "../lib/models";

// Required after the mocks so the routes pick them up.
/* eslint-disable @typescript-eslint/no-require-imports */
const { GET: getMyProfile } = require("../app/api/users/my-profile/route");
const {
  PUT: putUpdateProfile,
} = require("../app/api/users/update-profile/route");
const { PATCH: patchLocation } = require("../app/api/users/location/route");
/* eslint-enable @typescript-eslint/no-require-imports */

const HOUR = 60 * 60 * 1000;

const myProfile = () =>
  getMyProfile(
    new Request("http://localhost/api/users/my-profile", {
      headers: { authorization: "test-token" },
    }),
  );

const updateProfile = (body: unknown) =>
  putUpdateProfile(
    new Request("http://localhost/api/users/update-profile", {
      method: "PUT",
      headers: {
        authorization: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

const patchUserLocation = (body: unknown) =>
  patchLocation(
    new Request("http://localhost/api/users/location", {
      method: "PATCH",
      headers: {
        authorization: "test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

describe("profile-completion bonus — end to end", () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const createdIds: mongoose.Types.ObjectId[] = [];
  let seq = 0;

  /** Raw driver read — deliberately bypasses Mongoose and the endpoint echo. */
  const readRaw = async (id: mongoose.Types.ObjectId) => {
    const db = mongoose.connection.db;
    if (!db) throw new Error("not connected");
    return db.collection("users").findOne({ _id: id });
  };

  const makeUser = async (fields: Record<string, unknown> = {}) => {
    const user = await UserModel.create({
      userName: "Flow Probe",
      email: `bonus-flow-${seq}-${suffix}@example.com`,
      password: "irrelevant",
      mintId: String(20_000_000 + seq++),
      points: 100,
      ...fields,
    });
    createdIds.push(user._id);
    authUserId = String(user._id);
    return user;
  };

  beforeAll(async () => {
    await connectToDatabase();
  });

  beforeEach(() => {
    bonusConfig.enabled = true;
    bonusConfig.points = 100;
    bonusConfig.windowHours = 24;
    bonusConfig.campaignStart = null;
    bonusConfig.campaignEnd = null;
  });

  afterAll(async () => {
    if (createdIds.length) {
      await UserModel.deleteMany({ _id: { $in: createdIds } });
    }
    await mongoose.connection.close();
  });

  describe("GET /api/users/my-profile — opening the window", () => {
    it("stamps the window on the first open and returns it in that same response", async () => {
      const user = await makeUser({ phone: "", city: "" });

      const body = await (await myProfile()).json();

      // Returned on the FIRST response, not the second: a user who had to open
      // the app twice before seeing the badge would have burned part of a
      // window nobody told them about.
      expect(body.user.profileBonusWindowStartedAt).toBeTruthy();
      expect(
        (await readRaw(user._id))?.profileBonusWindowStartedAt,
      ).toBeInstanceOf(Date);
    });

    it("does not re-stamp on later opens", async () => {
      const user = await makeUser({ phone: "", city: "" });

      await myProfile();
      const first = (await readRaw(user._id))?.profileBonusWindowStartedAt;
      await myProfile();
      const second = (await readRaw(user._id))?.profileBonusWindowStartedAt;

      expect(second).toEqual(first);
    });

    it("does not stamp an already-complete profile", async () => {
      // Nothing to earn, so no window is opened and no badge is ever shown.
      const user = await makeUser({
        phone: "03001234567",
        city: "Karachi",
        town: "DHA",
        structuredAddress: { cityId: "Karachi", areaId: "DHA", houseNo: "9" },
      });

      await myProfile();

      expect(
        (await readRaw(user._id))?.profileBonusWindowStartedAt,
      ).toBeUndefined();
    });

    it("does not stamp while the campaign is off", async () => {
      bonusConfig.enabled = false;
      const user = await makeUser({ phone: "", city: "" });

      const res = await myProfile();

      expect(res.status).toBe(200);
      expect(
        (await readRaw(user._id))?.profileBonusWindowStartedAt,
      ).toBeUndefined();
    });
  });

  describe("completing the profile", () => {
    /**
     * The real sequence Edit Profile fires: update-profile with the identity
     * and legacy fields, then the structured location PATCH. Either request can
     * be the one that closes the last gap, and BOTH call the payout helper.
     */
    const completeViaBothRequests = async () => {
      await updateProfile({
        userName: "Ayesha",
        phone: "03001234567",
        province: "Sindh",
        city: "Karachi",
        town: "DHA",
        address: "Some street",
      });
      await patchUserLocation({
        structuredAddress: {
          cityId: "Karachi",
          areaId: "DHA",
          houseNo: "12-C",
        },
      });
    };

    it("pays exactly once across the two-request save", async () => {
      const user = await makeUser({ phone: "", city: "" });
      await myProfile();

      await completeViaBothRequests();

      const stored = await readRaw(user._id);
      // 100 at signup + 100 bonus. Additive, per the owner decision.
      expect(stored?.points).toBe(200);
      expect(stored?.profileBonusPoints).toBe(100);
      expect(stored?.profileBonusGrantedAt).toBeInstanceOf(Date);
    });

    it("does not pay again when the profile is saved a second time", async () => {
      const user = await makeUser({ phone: "", city: "" });
      await myProfile();

      await completeViaBothRequests();
      await completeViaBothRequests();

      expect((await readRaw(user._id))?.points).toBe(200);
    });

    it("does not pay after the window has elapsed", async () => {
      const user = await makeUser({
        phone: "",
        city: "",
        profileBonusWindowStartedAt: new Date(Date.now() - 25 * HOUR),
      });

      await completeViaBothRequests();

      const stored = await readRaw(user._id);
      expect(stored?.points).toBe(100);
      expect(stored?.profileBonusGrantedAt).toBeUndefined();
      // The profile itself still saved — expiry withdraws the bonus, not the
      // ability to finish your profile.
      expect(stored?.structuredAddress?.houseNo).toBe("12-C");
    });

    it("does not pay while the campaign is off, but still saves the profile", async () => {
      bonusConfig.enabled = false;
      const user = await makeUser({ phone: "", city: "" });
      await myProfile();

      await completeViaBothRequests();

      const stored = await readRaw(user._id);
      expect(stored?.points).toBe(100);
      expect(stored?.structuredAddress?.houseNo).toBe("12-C");
      expect(stored?.phone).toBe("03001234567");
    });

    it("does not pay a profile that is still incomplete", async () => {
      const user = await makeUser({ phone: "", city: "" });
      await myProfile();

      // Identity only — no house number, so evaluateLocation is unsatisfied.
      await updateProfile({
        userName: "Ayesha",
        phone: "03001234567",
        city: "Karachi",
        town: "DHA",
      });

      expect((await readRaw(user._id))?.points).toBe(100);
    });

    it("pays a user who never opened the app only after a window exists", async () => {
      // No my-profile call, so no window: the saves land, nothing is paid.
      const user = await makeUser({ phone: "", city: "" });

      await completeViaBothRequests();

      expect((await readRaw(user._id))?.points).toBe(100);
    });
  });
});
