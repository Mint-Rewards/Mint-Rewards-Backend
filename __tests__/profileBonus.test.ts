/// <reference types="jest" />

import mongoose from "mongoose";

// lib/env parses and freezes the environment once at module load, so the only
// way to drive several campaign configurations through one suite is to hand
// lib/profileBonus a mutable object in place of the real one. Same technique as
// __tests__/resendWebhook.test.ts. The functions under test read
// `serverEnv.appConfig.profileBonus` at CALL time, not at import time, so
// mutating `bonusConfig` between cases is enough — no module re-registry games.
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

import connectToDatabase from "../lib/mongodb";
import { UserModel } from "../lib/models";
import {
  awardProfileBonusIfEligible,
  isCampaignLive,
  isWindowOpen,
  startProfileBonusWindow,
} from "../lib/profileBonus";

const HOUR = 60 * 60 * 1000;

function resetConfig(): void {
  bonusConfig.enabled = true;
  bonusConfig.points = 100;
  bonusConfig.windowHours = 24;
  bonusConfig.campaignStart = null;
  bonusConfig.campaignEnd = null;
}

describe("profile-completion bonus", () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const createdIds: mongoose.Types.ObjectId[] = [];
  let mintSeq = 0;

  /**
   * A user who is COMPLETE by evaluateProfileCompletion's rules (Karachi is
   * tier A with a towns list, so the requirement set is cityId/areaId/houseNo
   * and no pin is demanded) and whose window opened `windowAgeMs` ago.
   */
  const makeUser = async (overrides: Record<string, unknown> = {}) => {
    const user = await UserModel.create({
      userName: "Ayesha",
      email: `bonus-${createdIds.length}-${suffix}@example.com`,
      password: "hashed-placeholder",
      phone: "03001234567",
      // 8-digit, unique per document — mintId is a unique index.
      mintId: String(10_000_000 + mintSeq++),
      points: 100,
      city: "Karachi",
      town: "DHA",
      structuredAddress: { cityId: "Karachi", areaId: "DHA", houseNo: "12-C" },
      profileBonusWindowStartedAt: new Date(Date.now() - HOUR),
      ...overrides,
    });
    createdIds.push(user._id);
    return user;
  };

  const pointsOf = async (id: mongoose.Types.ObjectId) =>
    (await UserModel.findById(id).select("points").lean())?.points;

  const docOf = async (id: mongoose.Types.ObjectId) =>
    await UserModel.findById(id).lean();

  beforeAll(async () => {
    await connectToDatabase();
  });

  beforeEach(() => {
    resetConfig();
  });

  afterAll(async () => {
    if (createdIds.length) {
      await UserModel.deleteMany({ _id: { $in: createdIds } });
    }
    await mongoose.connection.close();
  });

  describe("isCampaignLive", () => {
    it("is false when disabled, whatever the dates say", () => {
      bonusConfig.enabled = false;
      expect(isCampaignLive(new Date())).toBe(false);
    });

    it("is true with both bounds unset (an always-on campaign)", () => {
      expect(isCampaignLive(new Date())).toBe(true);
    });

    it("is false before the start and after the end", () => {
      bonusConfig.campaignStart = "2026-09-01T00:00:00Z";
      bonusConfig.campaignEnd = "2026-09-30T00:00:00Z";

      expect(isCampaignLive(new Date("2026-08-31T23:59:59Z"))).toBe(false);
      expect(isCampaignLive(new Date("2026-09-15T12:00:00Z"))).toBe(true);
      expect(isCampaignLive(new Date("2026-09-30T00:00:01Z"))).toBe(false);
    });
  });

  describe("isWindowOpen", () => {
    const now = new Date("2026-09-15T12:00:00Z");

    it("is open inside the window and closed past it", () => {
      expect(isWindowOpen(new Date(now.getTime() - 23 * HOUR), now)).toBe(true);
      expect(isWindowOpen(new Date(now.getTime() - 25 * HOUR), now)).toBe(false);
    });

    it("treats a never-stamped window as CLOSED, not open", () => {
      // The load-bearing case: "never opened the app" must not read as
      // "window open", or the bonus pays users it was never shown to.
      expect(isWindowOpen(null, now)).toBe(false);
      expect(isWindowOpen(undefined, now)).toBe(false);
    });

    it("honours a non-default windowHours", () => {
      bonusConfig.windowHours = 1;
      expect(isWindowOpen(new Date(now.getTime() - 2 * HOUR), now)).toBe(false);
    });
  });

  describe("startProfileBonusWindow", () => {
    it("stamps once and is a no-op on every later call", async () => {
      const user = await makeUser({ profileBonusWindowStartedAt: undefined });

      const first = await startProfileBonusWindow(user._id);
      expect(first).toBeInstanceOf(Date);

      const second = await startProfileBonusWindow(user._id);
      expect(second).toBeNull();

      const stored = await docOf(user._id);
      expect(stored?.profileBonusWindowStartedAt?.getTime()).toBe(
        first!.getTime(),
      );
    });

    it("returns null rather than throwing for a missing user", async () => {
      await expect(
        startProfileBonusWindow(new mongoose.Types.ObjectId()),
      ).resolves.toBeNull();
    });
  });

  describe("awardProfileBonusIfEligible", () => {
    it("pays the configured points to an eligible user", async () => {
      const user = await makeUser();

      await awardProfileBonusIfEligible(user._id);

      expect(await pointsOf(user._id)).toBe(200);
      const stored = await docOf(user._id);
      expect(stored?.profileBonusGrantedAt).toBeInstanceOf(Date);
      // Recorded at payout time, because there is no ledger to read it back from.
      expect(stored?.profileBonusPoints).toBe(100);
    });

    /**
     * The case that matters most. Both save paths call this helper, and the
     * client fires them in sequence on every profile save, so a second call is
     * the NORMAL flow rather than an edge case.
     */
    it("pays exactly once across repeated calls", async () => {
      const user = await makeUser();

      await awardProfileBonusIfEligible(user._id);
      await awardProfileBonusIfEligible(user._id);
      await awardProfileBonusIfEligible(user._id);

      expect(await pointsOf(user._id)).toBe(200);
    });

    it("pays exactly once when two calls race", async () => {
      const user = await makeUser();

      await Promise.all([
        awardProfileBonusIfEligible(user._id),
        awardProfileBonusIfEligible(user._id),
        awardProfileBonusIfEligible(user._id),
      ]);

      expect(await pointsOf(user._id)).toBe(200);
    });

    it("does not pay when the campaign is disabled", async () => {
      bonusConfig.enabled = false;
      const user = await makeUser();

      await awardProfileBonusIfEligible(user._id);

      expect(await pointsOf(user._id)).toBe(100);
      expect((await docOf(user._id))?.profileBonusGrantedAt).toBeUndefined();
    });

    it("does not pay outside the campaign dates", async () => {
      bonusConfig.campaignEnd = "2020-01-01T00:00:00Z";
      const user = await makeUser();

      await awardProfileBonusIfEligible(user._id);

      expect(await pointsOf(user._id)).toBe(100);
    });

    it("does not pay after the user's 24 hours have elapsed", async () => {
      const user = await makeUser({
        profileBonusWindowStartedAt: new Date(Date.now() - 25 * HOUR),
      });

      await awardProfileBonusIfEligible(user._id);

      expect(await pointsOf(user._id)).toBe(100);
    });

    it("does not pay a user whose window was never stamped", async () => {
      const user = await makeUser({ profileBonusWindowStartedAt: undefined });

      await awardProfileBonusIfEligible(user._id);

      expect(await pointsOf(user._id)).toBe(100);
    });

    it("does not pay an incomplete profile", async () => {
      const user = await makeUser({
        structuredAddress: { cityId: "Karachi", areaId: "DHA" },
      });

      await awardProfileBonusIfEligible(user._id);

      expect(await pointsOf(user._id)).toBe(100);
    });

    it("does not pay when the identity half is incomplete", async () => {
      const user = await makeUser({ phone: "" });

      await awardProfileBonusIfEligible(user._id);

      expect(await pointsOf(user._id)).toBe(100);
    });

    it("pays a profile that becomes complete on a later call", async () => {
      const user = await makeUser({
        structuredAddress: { cityId: "Karachi", areaId: "DHA" },
      });

      await awardProfileBonusIfEligible(user._id);
      expect(await pointsOf(user._id)).toBe(100);

      // The house number arrives on the second of the client's two requests.
      await UserModel.updateOne(
        { _id: user._id },
        { $set: { "structuredAddress.houseNo": "12-C" } },
      );
      await awardProfileBonusIfEligible(user._id);

      expect(await pointsOf(user._id)).toBe(200);
    });

    it("swallows a missing user rather than throwing", async () => {
      await expect(
        awardProfileBonusIfEligible(new mongoose.Types.ObjectId()),
      ).resolves.toBeUndefined();
    });
  });
});
