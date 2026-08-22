/// <reference types="jest" />

import crypto from "crypto";
import connectToDatabase from "../lib/mongodb";
import { EmailSuppressionModel, isSuppressed } from "../lib/emailSuppression";
import { unsubscribeToken } from "../lib/unsubscribeToken";
import {
  GET as getUnsubscribe,
  POST as postUnsubscribe,
} from "../app/api/email/unsubscribe/route";

describe("/api/email/unsubscribe (#145)", () => {
  const suffix = crypto.randomBytes(6).toString("hex");
  const addr = (local: string) => `${local}-${suffix}@example.com`;
  const created: string[] = [];

  const link = (email: string, token = unsubscribeToken(email)) =>
    new Request(
      `http://localhost/api/email/unsubscribe?email=${encodeURIComponent(
        email,
      )}&token=${encodeURIComponent(token)}`,
    );

  beforeAll(async () => {
    await connectToDatabase();
  });

  afterAll(async () => {
    await EmailSuppressionModel.deleteMany({ _id: { $in: created } });
  });

  it("unsubscribes with no session at all", async () => {
    // The recipient of a referral invitation has no account; requiring auth
    // would make the link unusable for exactly the people it is for.
    const email = addr("no-session");
    created.push(email);

    const res = await getUnsubscribe(link(email));

    expect(res.status).toBe(200);
    expect(await isSuppressed(email, "outreach")).toBe(true);
  });

  it("refuses a forged token and suppresses nothing", async () => {
    const email = addr("forged");
    created.push(email);

    const res = await getUnsubscribe(link(email, "forged-token"));

    expect(res.status).toBe(400);
    expect(await isSuppressed(email, "outreach")).toBe(false);
  });

  it("refuses one recipient's token used for another address", async () => {
    const victim = addr("victim");
    created.push(victim);

    const res = await getUnsubscribe(
      link(victim, unsubscribeToken(addr("attacker"))),
    );

    expect(res.status).toBe(400);
    expect(await isSuppressed(victim, "outreach")).toBe(false);
  });

  it("gives the same answer for a bad token and a malformed address", async () => {
    // Telling them apart would confirm which addresses this system knows.
    const bad = await getUnsubscribe(link(addr("known"), "nope"));
    const malformed = await getUnsubscribe(
      new Request(
        "http://localhost/api/email/unsubscribe?email=not-an-email&token=x",
      ),
    );

    expect(bad.status).toBe(malformed.status);
    expect(await bad.text()).toBe(await malformed.text());
  });

  it("handles a mail client's one-click POST", async () => {
    const email = addr("one-click");
    created.push(email);

    const res = await postUnsubscribe(link(email));

    expect(res.status).toBe(200);
    expect(await isSuppressed(email, "outreach")).toBe(true);
  });

  it("is not cacheable or indexable", async () => {
    const email = addr("cache");
    created.push(email);

    const res = await getUnsubscribe(link(email));

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("is idempotent", async () => {
    const email = addr("twice");
    created.push(email);

    expect((await getUnsubscribe(link(email))).status).toBe(200);
    expect((await getUnsubscribe(link(email))).status).toBe(200);
    expect(await isSuppressed(email, "outreach")).toBe(true);
  });
});
