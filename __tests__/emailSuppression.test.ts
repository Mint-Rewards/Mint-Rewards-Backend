/// <reference types="jest" />

import crypto from "crypto";
import connectToDatabase from "../lib/mongodb";
import {
  EmailSuppressionModel,
  isSuppressed,
  suppressAddress,
} from "../lib/emailSuppression";
import {
  unsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
} from "../lib/unsubscribeToken";
import { verifySvixSignature } from "../lib/svix";

describe("email suppression (#145)", () => {
  const suffix = crypto.randomBytes(6).toString("hex");
  const addr = (local: string) => `${local}-${suffix}@example.com`;
  const created: string[] = [];

  const suppress = async (
    address: string,
    reason: Parameters<typeof suppressAddress>[1],
  ) => {
    created.push(address);
    await suppressAddress(address, reason, "test");
  };

  beforeAll(async () => {
    await connectToDatabase();
  });

  afterAll(async () => {
    await EmailSuppressionModel.deleteMany({ _id: { $in: created } });
  });

  it("suppresses an unopted-in address for outreach", async () => {
    const address = addr("unsub");
    await suppress(address, "unsubscribe");

    expect(await isSuppressed(address, "outreach")).toBe(true);
  });

  // The asymmetry is the point of the whole design: honouring an opt-out must
  // not lock somebody out of their own account.
  it("still delivers transactional mail to an unsubscribed address", async () => {
    const address = addr("unsub-transactional");
    await suppress(address, "unsubscribe");

    expect(await isSuppressed(address, "transactional")).toBe(false);
  });

  it("stops transactional mail after a hard bounce", async () => {
    const address = addr("bounced");
    await suppress(address, "bounce");

    expect(await isSuppressed(address, "transactional")).toBe(true);
    expect(await isSuppressed(address, "outreach")).toBe(true);
  });

  it("stops transactional mail after a spam complaint", async () => {
    const address = addr("complained");
    await suppress(address, "complaint");

    expect(await isSuppressed(address, "transactional")).toBe(true);
  });

  it("does not downgrade a bounce to an unsubscribe", async () => {
    const address = addr("bounce-then-unsub");
    await suppress(address, "bounce");
    await suppress(address, "unsubscribe");

    // Still blocks transactional mail — the stricter reason survives.
    expect(await isSuppressed(address, "transactional")).toBe(true);
  });

  it("normalises casing and whitespace on both write and read", async () => {
    const address = addr("Mixed.Case");
    await suppress(`  ${address.toUpperCase()}  `, "unsubscribe");

    expect(await isSuppressed(address.toLowerCase(), "outreach")).toBe(true);
  });

  it("leaves an unknown address sendable", async () => {
    expect(await isSuppressed(addr("never-seen"), "outreach")).toBe(false);
  });
});

describe("unsubscribe tokens (#145)", () => {
  const address = "recipient@example.com";

  it("verifies a token it issued", () => {
    expect(verifyUnsubscribeToken(address, unsubscribeToken(address))).toBe(
      true,
    );
  });

  it("rejects a token issued for a different address", () => {
    // Otherwise one valid link unsubscribes anybody.
    expect(
      verifyUnsubscribeToken(
        "someone-else@example.com",
        unsubscribeToken(address),
      ),
    ).toBe(false);
  });

  it("rejects a missing or garbage token", () => {
    expect(verifyUnsubscribeToken(address, "")).toBe(false);
    expect(verifyUnsubscribeToken(address, "not-a-token")).toBe(false);
  });

  it("ignores casing, matching how the address is stored", () => {
    expect(
      verifyUnsubscribeToken(
        "RECIPIENT@example.com",
        unsubscribeToken(address),
      ),
    ).toBe(true);
  });

  it("builds an absolute link carrying the address and token", () => {
    const url = new URL(unsubscribeUrl(address, "https://api.example.com/"));

    expect(url.pathname).toBe("/api/email/unsubscribe");
    expect(url.searchParams.get("email")).toBe(address);
    expect(
      verifyUnsubscribeToken(address, url.searchParams.get("token") ?? ""),
    ).toBe(true);
  });
});

describe("Resend webhook signatures (#145)", () => {
  const secret = `whsec_${Buffer.from("test-signing-key").toString("base64")}`;
  const body = JSON.stringify({ type: "email.bounced" });

  const sign = (id: string, timestamp: string, payload: string) =>
    crypto
      .createHmac(
        "sha256",
        Buffer.from(secret.replace(/^whsec_/, ""), "base64"),
      )
      .update(`${id}.${timestamp}.${payload}`)
      .digest("base64");

  const now = () => String(Math.floor(Date.now() / 1000));

  it("accepts a correctly signed delivery", () => {
    const id = "msg_1";
    const timestamp = now();

    expect(
      verifySvixSignature(
        body,
        { id, timestamp, signature: `v1,${sign(id, timestamp, body)}` },
        secret,
      ),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    // The whole point: without this, anyone can suppress any address.
    const id = "msg_2";
    const timestamp = now();
    const signature = `v1,${sign(id, timestamp, body)}`;

    expect(
      verifySvixSignature(
        JSON.stringify({ type: "email.bounced", data: { to: "victim@x.com" } }),
        { id, timestamp, signature },
        secret,
      ),
    ).toBe(false);
  });

  it("rejects a replayed delivery outside the tolerance window", () => {
    const id = "msg_3";
    const timestamp = String(Math.floor(Date.now() / 1000) - 60 * 60);

    expect(
      verifySvixSignature(
        body,
        { id, timestamp, signature: `v1,${sign(id, timestamp, body)}` },
        secret,
      ),
    ).toBe(false);
  });

  it("accepts one valid signature among several offered", () => {
    // Secret rotation publishes both.
    const id = "msg_4";
    const timestamp = now();

    expect(
      verifySvixSignature(
        body,
        {
          id,
          timestamp,
          signature: `v1,${"A".repeat(44)} v1,${sign(id, timestamp, body)}`,
        },
        secret,
      ),
    ).toBe(true);
  });

  it("rejects missing headers", () => {
    expect(
      verifySvixSignature(
        body,
        { id: null, timestamp: null, signature: null },
        secret,
      ),
    ).toBe(false);
  });
});
