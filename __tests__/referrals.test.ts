/// <reference types="jest" />

import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import connectToDatabase from "../lib/mongodb";
import { UserModel } from "../lib/models";

// The fan-out is the thing under test, so the send itself is mocked: these
// cases are about which addresses are attempted and which are recorded, and a
// real Resend call would make the outcome depend on the network.
//
// `sendResults` lets an individual case decide that a specific address fails,
// which is how the write-after-send guarantee is exercised.
const sendResults = new Map<string, boolean>();
const attempted: string[] = [];

jest.mock("../emailServices/referralEmail", () => ({
  __esModule: true,
  default: jest.fn(async ({ recipientEmail }: { recipientEmail: string }) => {
    attempted.push(recipientEmail);
    return sendResults.get(recipientEmail) ?? true;
  }),
}));

// Rate limiting is defence-in-depth and is covered by its own behaviour; a
// suite that runs several batches back to back would otherwise trip the 3/hour
// per-user cap and start asserting against 429s.
jest.mock("../lib/rateLimit", () => ({
  ...jest.requireActual("../lib/rateLimit"),
  checkRateLimit: jest.fn(async () => ({
    limited: false,
    retryAfterSeconds: 0,
  })),
}));

import { POST as postReferrals } from "../app/api/users/referrals/route";

function referralRequest(userId: string, emails: unknown): Request {
  const token = jwt.sign({ id: userId }, process.env.JWT_SECRET || "");
  return new Request("http://localhost/api/users/referrals", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ emails }),
  });
}

describe("POST /api/users/referrals", () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const createdUserIds: mongoose.Types.ObjectId[] = [];

  const addr = (local: string) => `${local}-${suffix}@example.com`;

  const makeUser = async (fields: Record<string, unknown> = {}) => {
    const user = await UserModel.create({
      userName: "Referrer",
      email: addr(`user-${createdUserIds.length}`),
      password: "hashed-placeholder",
      mintId: `MINT-${suffix.slice(-6)}-${createdUserIds.length}`,
      ...fields,
    });
    createdUserIds.push(user._id as mongoose.Types.ObjectId);
    return user;
  };

  beforeAll(async () => {
    await connectToDatabase();
  });

  beforeEach(() => {
    sendResults.clear();
    attempted.length = 0;
  });

  afterAll(async () => {
    await UserModel.deleteMany({ _id: { $in: createdUserIds } });
  });

  // Issue #144 defect 1 / acceptance 1.
  it("delivers to every valid address when one is already referred", async () => {
    const stranger = await makeUser();
    const collided = addr("collided");
    stranger.referrals = [collided];
    await stranger.save();

    const referrer = await makeUser();
    const fresh = [addr("fresh-a"), addr("fresh-b")];

    const res = await postReferrals(
      referralRequest(String(referrer._id), [collided, ...fresh]),
    );

    expect(res.status).toBe(200);
    // The old route returned 400 here and sent nothing at all.
    expect(attempted.sort()).toEqual(fresh.sort());

    const body = await res.json();
    expect(body).toEqual({ requested: 3, sent: 2, skipped: 1 });
  });

  // Issue #144 defects 2-4 / acceptance 2.
  it("leaves an address re-referable when its send fails", async () => {
    const referrer = await makeUser();
    const bouncing = addr("bouncing");
    const delivered = addr("delivered");
    sendResults.set(bouncing, false);

    const res = await postReferrals(
      referralRequest(String(referrer._id), [bouncing, delivered]),
    );

    expect(await res.json()).toEqual({ requested: 2, sent: 1, skipped: 1 });

    const saved = await UserModel.findById(referrer._id).select("referrals");
    // The failed address must not be recorded — recording it under a global
    // dedupe locked the recipient out of the feature permanently.
    expect(saved?.referrals).toEqual([delivered]);

    // And a retry actually reaches it.
    attempted.length = 0;
    sendResults.clear();
    await postReferrals(referralRequest(String(referrer._id), [bouncing]));
    expect(attempted).toEqual([bouncing]);
  });

  it("records an address only once its send succeeds", async () => {
    const referrer = await makeUser();
    const target = addr("all-failed");
    sendResults.set(target, false);

    const res = await postReferrals(
      referralRequest(String(referrer._id), [target]),
    );

    expect(await res.json()).toEqual({ requested: 1, sent: 0, skipped: 1 });
    const saved = await UserModel.findById(referrer._id).select("referrals");
    expect(saved?.referrals).toEqual([]);
  });

  // Issue #144 acceptance 3, and the constraint the issue says not to undo.
  it("does not disclose which addresses were skipped or why", async () => {
    const registeredUser = await makeUser();
    const referrer = await makeUser();

    const res = await postReferrals(
      referralRequest(String(referrer._id), [
        registeredUser.email,
        addr("ordinary"),
      ]),
    );

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["requested", "sent", "skipped"]);

    // No address, and no reason, anywhere in the payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(registeredUser.email);
    expect(raw).not.toContain("registered");
    expect(raw).not.toContain("already");
  });

  it("skips registered addresses without recording or emailing them", async () => {
    const registeredUser = await makeUser();
    const referrer = await makeUser();

    await postReferrals(
      referralRequest(String(referrer._id), [registeredUser.email]),
    );

    expect(attempted).toEqual([]);
    const saved = await UserModel.findById(referrer._id).select("referrals");
    expect(saved?.referrals).toEqual([]);
  });

  it("still rejects a self-referral outright", async () => {
    const referrer = await makeUser();

    const res = await postReferrals(
      referralRequest(String(referrer._id), [referrer.email]),
    );

    expect(res.status).toBe(400);
    expect(attempted).toEqual([]);
  });

  it("collapses duplicates and casing within one batch", async () => {
    const referrer = await makeUser();
    const target = addr("dupe");

    const res = await postReferrals(
      referralRequest(String(referrer._id), [
        target,
        `  ${target.toUpperCase()}  `,
      ]),
    );

    expect(attempted).toEqual([target]);
    expect(await res.json()).toEqual({ requested: 1, sent: 1, skipped: 0 });
  });
});
