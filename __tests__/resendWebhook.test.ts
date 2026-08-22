/// <reference types="jest" />

import crypto from "crypto";

const WEBHOOK_SECRET = `whsec_${Buffer.from("webhook-test-key").toString(
  "base64",
)}`;

// serverEnv is frozen at module load, so the secret is injected by mocking the
// module rather than by setting process.env after the fact.
jest.mock("../lib/env", () => {
  const actual = jest.requireActual("../lib/env");
  return {
    ...actual,
    serverEnv: { ...actual.serverEnv, resendWebhookSecret: WEBHOOK_SECRET },
  };
});

import connectToDatabase from "../lib/mongodb";
import { EmailSuppressionModel, isSuppressed } from "../lib/emailSuppression";
import { POST as postWebhook } from "../app/api/webhooks/resend/route";

describe("/api/webhooks/resend (#145)", () => {
  const suffix = crypto.randomBytes(6).toString("hex");
  const addr = (local: string) => `${local}-${suffix}@example.com`;
  const created: string[] = [];

  const delivery = (payload: unknown, signed = true) => {
    const body = JSON.stringify(payload);
    const id = `msg_${crypto.randomBytes(4).toString("hex")}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto
      .createHmac(
        "sha256",
        Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ""), "base64"),
      )
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");

    return new Request("http://localhost/api/webhooks/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signed ? `v1,${signature}` : "v1,not-the-signature",
      },
      body,
    });
  };

  beforeAll(async () => {
    await connectToDatabase();
  });

  afterAll(async () => {
    await EmailSuppressionModel.deleteMany({ _id: { $in: created } });
  });

  // Acceptance: a hard bounce suppresses the address for all future sends.
  it("suppresses a bounced address for every category", async () => {
    const email = addr("hard-bounce");
    created.push(email);

    const res = await postWebhook(
      delivery({ type: "email.bounced", data: { to: [email] } }),
    );

    expect(res.status).toBe(200);
    expect(await isSuppressed(email, "outreach")).toBe(true);
    expect(await isSuppressed(email, "transactional")).toBe(true);
  });

  it("suppresses on a spam complaint", async () => {
    const email = addr("complaint");
    created.push(email);

    await postWebhook(
      delivery({ type: "email.complained", data: { to: email } }),
    );

    expect(await isSuppressed(email, "transactional")).toBe(true);
  });

  it("rejects an unsigned delivery without suppressing", async () => {
    // An unsigned suppression endpoint is a denial of service on password
    // resets: anyone could suppress anyone.
    const email = addr("forged");
    created.push(email);

    const res = await postWebhook(
      delivery({ type: "email.bounced", data: { to: email } }, false),
    );

    expect(res.status).toBe(401);
    expect(await isSuppressed(email, "transactional")).toBe(false);
  });

  it("ignores delivery and engagement events", async () => {
    const email = addr("delivered");
    created.push(email);

    const res = await postWebhook(
      delivery({ type: "email.delivered", data: { to: email } }),
    );

    // 200 so Resend does not retry an event that will never change anything.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, suppressed: 0 });
    expect(await isSuppressed(email, "outreach")).toBe(false);
  });

  it("suppresses every recipient of a multi-address bounce", async () => {
    const a = addr("multi-a");
    const b = addr("multi-b");
    created.push(a, b);

    await postWebhook(
      delivery({ type: "email.bounced", data: { to: [a, b] } }),
    );

    expect(await isSuppressed(a, "transactional")).toBe(true);
    expect(await isSuppressed(b, "transactional")).toBe(true);
  });
});
