/**
 * Consumer accounts on Postgres.
 *
 * Two things are worth more than the rest here, and both are tested against a
 * real database rather than argued.
 *
 * The projection: `password`, `password_reset` and `email_verification` held
 * OTP and password hashes behind Mongoose's `select: false`. Postgres has no
 * such flag, so if the default read ever returns one of them, every route
 * that echoes a user object starts leaking credentials.
 *
 * The guards: the bonus is paid once, the referral is credited once, and an
 * OTP is burnt once. A lost race on any of them costs points or lets a spent
 * code be reused.
 *
 * jest.setup.js unsets DATABASE_URL unless DATABASE_URL_TEST is set, so the
 * whole file skips by default.
 */
import * as repo from "@/lib/repositories/users";
import { newObjectId } from "@/lib/repositories/brandhub";

const LIVE = Boolean(process.env.DATABASE_URL);
const whenLive = LIVE ? describe : describe.skip;

const made: string[] = [];

async function makeUser(over: Partial<repo.NewUser> = {}) {
  const id = newObjectId();
  const user = await repo.createUser({
    _id: id,
    userName: `probe-${id}`,
    email: `probe-${id}@example.invalid`,
    password: "$2b$10$notarealhashnotarealhashnotarealhashnotarealhash12",
    mintId: `PROBE-${id}`,
    ...over,
  });
  made.push(user._id);
  /*
   * Narrowed here rather than at each of the sixteen call sites below.
   *
   * `email` became nullable when an account could first be created from a
   * phone number alone. This fixture always supplies one, so saying that once
   * keeps every test about the thing it is actually testing — and the throw
   * means a future change to the fixture fails loudly rather than handing a
   * null to a lookup that quietly finds nobody.
   */
  if (!user.email) throw new Error("fixture user was created without an email");
  return { ...user, email: user.email };
}

whenLive("consumer accounts", () => {
  afterAll(async () => {
    for (const id of made) await repo.purgeUser(id);
    const { closePostgres } = await import("@/lib/postgres");
    await closePostgres();
  });

  describe("leaving, and coming back", () => {
    /*
     * Deleting used to destroy the row, and that was being played.
     *
     * A deal hands out one code per USER ID — `AND NOT (user_id = ANY(users))`
     * in claimDealCode — so a new id meant a second code from the same deal.
     * Delete, sign up with the same address, claim again, repeat until the
     * brand's whole allocation was gone. The referral reward and the hundred
     * point signup grant were open the same way, and nothing could notice
     * because nothing keyed on anything that survived the delete.
     *
     * So the row survives and the id with it. What these pin is that the
     * account is genuinely gone from every reader's point of view, and that
     * coming back is the SAME person with nothing.
     */
    it("keeps the row, so the person keeps their id", async () => {
      const user = await makeUser();
      expect(await repo.deleteUser(user._id)).toBe(true);

      // Gone to every reader...
      expect(await repo.findUserById(user._id)).toBeNull();
      expect(await repo.findUserByEmail(user.email)).toBeNull();
      expect(await repo.findUserByEmailForLogin(user.email)).toBeNull();

      // ...and still there underneath, which is the whole point.
      const back = await repo.reviveUser(user.email, {});
      expect(back).not.toBeNull();
      expect(back!._id).toBe(user._id);
    });

    it("zeroes the points and the record of what they recycled", async () => {
      const user = await makeUser();
      await repo.addPoints(user._id, 500);
      await repo.deleteUser(user._id);

      const back = await repo.reviveUser(user.email, {});
      expect(back!.points).toBe(0);
      expect(back!.totalCo2Kg).toBe(0);
      expect(back!.totalWasteCollected).toBe("");
      // Coming back must not restore a balance they asked us to destroy.
    });

    it("cannot be logged into while deleted", async () => {
      const user = await makeUser();
      await repo.deleteUser(user._id);
      expect(await repo.findUserByEmailForLogin(user.email)).toBeNull();
      expect(
        await repo.findUserByEmailWithOtp(user.email, "passwordReset"),
      ).toBeNull();
    });

    it("refuses to revive an account that was never deleted", async () => {
      // So a revival cannot be used to take over a live account.
      const user = await makeUser();
      expect(await repo.reviveUser(user.email, {})).toBeNull();
    });

    it("deletes once, not twice", async () => {
      const user = await makeUser();
      expect(await repo.deleteUser(user._id)).toBe(true);
      expect(await repo.deleteUser(user._id)).toBe(false);
    });

    it("is findable again once revived", async () => {
      const user = await makeUser();
      await repo.deleteUser(user._id);
      await repo.reviveUser(user.email, { userName: "Back Again" });

      const found = await repo.findUserByEmail(user.email);
      expect(found).not.toBeNull();
      expect(found!._id).toBe(user._id);
      expect(found!.userName).toBe("Back Again");
    });
  });

  describe("a signup with no pin", () => {
    /*
     * The bug this pins, as an operator met it: sign up with only a name,
     * email and password and the request answers 500 — having already created
     * the account.
     *
     * `latitude` and `longitude` are NOT NULL text columns and the signup
     * route defaulted both to `null`. updateUser skips `undefined` and passes
     * `null` straight through, so the write violated the constraint after
     * createUser had committed. The result was an account with no points, no
     * verification code, able to log in and unable to verify — and signing up
     * again said "email already in use", which is how it reached us as a bug
     * about deleted accounts.
     */
    it("refuses a null coordinate, so the route must not send one", async () => {
      const user = await makeUser();
      await expect(
        repo.updateUser(user._id, {
          latitude: null,
          longitude: null,
        } as unknown as Parameters<typeof repo.updateUser>[1]),
      ).rejects.toThrow();
    });

    it("leaves the columns empty when the fields are simply absent", async () => {
      // What the route now sends: the keys are omitted, not nulled, and the
      // empty string is what "no pin yet" means everywhere else in this table.
      const user = await makeUser();
      const updated = await repo.updateUser(user._id, {
        address: "House 1",
        city: "Karachi",
      });
      expect(updated).not.toBeNull();
      expect(updated!.latitude).toBe("");
      expect(updated!.longitude).toBe("");
      expect(updated!.address).toBe("House 1");
    });
  });

  describe("what a read gives back", () => {
    it("never includes the password hash", async () => {
      // If this ever fails, every route that returns a user object is
      // returning a bcrypt hash with it.
      const user = await makeUser();
      const read = await repo.findUserById(user._id);
      expect(read).not.toBeNull();
      expect(read as unknown as Record<string, unknown>).not.toHaveProperty(
        "password",
      );
    });

    it("never includes either OTP block", async () => {
      const user = await makeUser();
      await repo.setUserOtp(user._id, "passwordReset", {
        otpHash: "secret-hash",
        attempts: 0,
      });
      const read = (await repo.findUserById(user._id)) as unknown as Record<
        string,
        unknown
      >;
      expect(read).not.toHaveProperty("passwordReset");
      expect(read).not.toHaveProperty("password_reset");
      expect(JSON.stringify(read)).not.toContain("secret-hash");
    });

    it("gives the password hash only to the login read", async () => {
      const user = await makeUser();
      const login = await repo.findUserByEmailForLogin(user.email);
      expect(login?.password).toMatch(/^\$2b\$/);
    });

    it("gives an OTP block only when asked for that one", async () => {
      const user = await makeUser();
      await repo.setUserOtp(user._id, "emailVerification", {
        otpHash: "email-hash",
      });
      const withEmail = await repo.findUserByEmailWithOtp(
        user.email,
        "emailVerification",
      );
      expect(withEmail?.otp?.otpHash).toBe("email-hash");
      // Asking for the other one must not hand over this one.
      const withReset = await repo.findUserByEmailWithOtp(
        user.email,
        "passwordReset",
      );
      expect(withReset?.otp).toBeNull();
    });
  });

  describe("the profile bonus", () => {
    it("opens the window once", async () => {
      const user = await makeUser();
      const first = await repo.startBonusWindow(user._id, new Date());
      const second = await repo.startBonusWindow(user._id, new Date());
      expect(first).toBeInstanceOf(Date);
      expect(second).toBeNull();
    });

    it("pays once, even with ten concurrent callers", async () => {
      // The bug this prevents pays somebody ten times.
      const user = await makeUser();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          repo.payProfileBonus(user._id, 50, new Date()),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);

      const after = await repo.findUserById(user._id);
      expect(after?.points).toBe(50);
      expect(after?.profileBonusPoints).toBe(50);
      expect(after?.profileBonusGrantedAt).toBeInstanceOf(Date);
    });

    it("does not pay again later", async () => {
      const user = await makeUser();
      await repo.payProfileBonus(user._id, 50, new Date());
      expect(await repo.payProfileBonus(user._id, 50, new Date())).toBe(false);
      expect((await repo.findUserById(user._id))?.points).toBe(50);
    });
  });

  describe("referrals", () => {
    it("credits the referee once under concurrency", async () => {
      const user = await makeUser();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => repo.claimReferralReward(user._id, 25)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const after = await repo.findUserById(user._id);
      expect(after?.points).toBe(25);
      expect(after?.referralRewardGranted).toBe(true);
    });

    it("credits the referrer every time, since it pays per referral", async () => {
      const user = await makeUser();
      await repo.addPoints(user._id, 25);
      await repo.addPoints(user._id, 25);
      expect((await repo.findUserById(user._id))?.points).toBe(50);
    });

    it("finds a referrer by a referred address", async () => {
      const user = await makeUser();
      await repo.updateUser(user._id, {
        referrals: ["friend@example.invalid"],
      });
      const found = await repo.findUserByReferral("FRIEND@example.invalid");
      expect(found?._id).toBe(user._id);
    });
  });

  describe("one-time codes", () => {
    it("burns a code once", async () => {
      const user = await makeUser();
      await repo.setUserOtp(user._id, "passwordReset", { otpHash: "h1" });
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          repo.consumeOtp(user._id, "passwordReset", "h1"),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("refuses to burn a code that has been rotated", async () => {
      // A concurrent resend replaced it; the guess against the old one must
      // not consume the new code.
      const user = await makeUser();
      await repo.setUserOtp(user._id, "passwordReset", { otpHash: "new" });
      expect(await repo.consumeOtp(user._id, "passwordReset", "old")).toBe(
        false,
      );
      const still = await repo.findUserByEmailWithOtp(
        user.email,
        "passwordReset",
      );
      expect(still?.otp?.otpHash).toBe("new");
    });

    it("counts each wrong guess exactly once", async () => {
      const user = await makeUser();
      await repo.setUserOtp(user._id, "passwordReset", {
        otpHash: "h2",
        attempts: 0,
      });
      await Promise.all(
        Array.from({ length: 5 }, () =>
          repo.recordOtpAttempt(user._id, "passwordReset", "h2"),
        ),
      );
      const after = await repo.findUserByEmailWithOtp(
        user.email,
        "passwordReset",
      );
      // Under-counting here would let someone brute force past MAX_ATTEMPTS.
      expect(after?.otp?.attempts).toBe(5);
    });

    it("does not count a guess against a rotated code", async () => {
      const user = await makeUser();
      await repo.setUserOtp(user._id, "passwordReset", {
        otpHash: "current",
        attempts: 0,
      });
      expect(
        await repo.recordOtpAttempt(user._id, "passwordReset", "stale"),
      ).toBe(false);
      const after = await repo.findUserByEmailWithOtp(
        user.email,
        "passwordReset",
      );
      expect(after?.otp?.attempts).toBe(0);
    });

    it("verifies the address and burns the code together", async () => {
      const user = await makeUser();
      await repo.setUserOtp(user._id, "emailVerification", { otpHash: "e1" });
      expect(await repo.markEmailVerified(user._id, "e1")).toBe(true);
      const after = await repo.findUserById(user._id);
      expect(after?.emailVerified).toBe(true);
      const otp = await repo.findUserByEmailWithOtp(
        user.email,
        "emailVerification",
      );
      expect(otp?.otp).toBeNull();
    });
  });

  describe("location", () => {
    it("round-trips a coordinate in [lng, lat] order", async () => {
      // Karachi. Getting this backwards puts everyone in the Indian Ocean,
      // and both numbers are plausible latitudes.
      const user = await makeUser();
      await repo.updateUser(user._id, {
        location: {
          type: "Point",
          coordinates: [67.0011, 24.8607],
          precision: "building",
          source: "map_pin",
        },
      });
      const after = await repo.findUserById(user._id);
      expect(after?.location?.coordinates?.[0]).toBeCloseTo(67.0011, 5);
      expect(after?.location?.coordinates?.[1]).toBeCloseTo(24.8607, 5);
      expect(after?.location?.precision).toBe("building");
    });

    it("clears a coordinate when given null", async () => {
      const user = await makeUser();
      await repo.updateUser(user._id, {
        location: {
          type: "Point",
          coordinates: [67, 24],
          precision: "building",
        },
      });
      await repo.updateUser(user._id, { location: null });
      const after = await repo.findUserById(user._id);
      expect(after?.location).toBeUndefined();
      // And the precision with it — a stale "building" would put the row back
      // in the routable set with no pin to route to.
      const raw = await (
        await import("@/lib/postgres")
      )
        .getPool()
        .query("SELECT precision, source FROM consumer.users WHERE id = $1", [
          user._id,
        ]);
      expect(raw.rows[0]).toEqual({ precision: null, source: null });
    });

    it("leaves the coordinate alone when the patch omits it", async () => {
      const user = await makeUser();
      await repo.updateUser(user._id, {
        location: { type: "Point", coordinates: [67, 24] },
      });
      await repo.updateUser(user._id, { city: "Karachi" });
      expect((await repo.findUserById(user._id))?.location).toBeDefined();
    });
  });
});
