/**
 * Signing up and signing in with a phone number, end to end.
 *
 * The two rules worth protecting are the ones that are easy to lose and
 * invisible when lost: signing in must not create an account, and a code must
 * not be spendable twice. Everything else here is the ordinary path.
 *
 * Runs against the stub sender, which is the point of having one — no
 * WhatsApp number exists yet and the flow still has to be provable.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from "@jest/globals";

/*
 * `after()` never fires here.
 *
 * Next defers it until the response has flushed, which needs a request
 * context — and these tests call the handler directly, so the deferred send
 * is simply dropped. The route is right to defer: the person should not wait
 * on WhatsApp. So the shim runs the callback instead of discarding it, which
 * is the only way to assert that a code was actually handed to a sender.
 */
const deferred: Promise<unknown>[] = [];
jest.mock("next/server", () => {
  const actual = jest.requireActual("next/server") as Record<string, unknown>;
  return {
    ...actual,
    after: (fn: () => Promise<unknown>) => {
      deferred.push(Promise.resolve().then(fn));
    },
  };
});

/** Lets a test wait for the send the route deferred. */
const settle = async () => {
  await Promise.all(deferred.splice(0));
};

jest.mock("../lib/rateLimit", () => {
  const actual = jest.requireActual("../lib/rateLimit") as object;
  return {
    ...actual,
    // Not under test here, and a shared limiter would make these flaky in
    // whatever order they happen to run.
    checkRateLimit: jest.fn(async () => ({ limited: false, retryAfterSeconds: 0 })),
  };
});

import { POST as start } from "@/app/api/users/phone/start/route";
import { POST as verify } from "@/app/api/users/phone/verify/route";
import { setOtpSender } from "@/whatsappServices/otpSender";
import * as repo from "@/lib/repositories/users";

/** Captures the code instead of sending it, so the test can answer it. */
const sent: { to: string; code: string }[] = [];
setOtpSender({
  name: "test",
  async send(to, code) {
    sent.push({ to, code });
    return { ok: true, providerId: null };
  },
});

const NUMBER = "03005550101";
const E164 = "+923005550101";

const post = (handler: (r: Request) => Promise<Response>, path: string, body: unknown) =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const made: string[] = [];

async function cleanup() {
  for (const id of made.splice(0)) await repo.purgeUser(id);
}

describe("signing up with a number", () => {
  beforeEach(async () => {
    sent.length = 0;
    await cleanup();
  });
  afterAll(cleanup);

  it("sends a code and creates an unverified account", async () => {
    const res = await post(start, "/api/users/phone/start", {
      phone: NUMBER,
      intent: "signup",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; sent: boolean };
    made.push(body.userId);

    expect(body.sent).toBe(true);
    await settle();
    expect(sent).toHaveLength(1);
    // Normalised before anything else touches it: one SIM, one string.
    expect(sent[0]!.to).toBe(E164);

    const user = await repo.findUserById(body.userId);
    expect(user).not.toBeNull();
    expect(user!.email).toBeNull();
    // Not yet an identity — the unique index only covers verified rows.
    expect(await repo.findUserByPhone(E164)).toBeNull();
  });

  it("signs them in once they answer it", async () => {
    const started = (await (
      await post(start, "/api/users/phone/start", { phone: NUMBER, intent: "signup" })
    ).json()) as { userId: string };
    made.push(started.userId);
    await settle();

    const res = await post(verify, "/api/users/phone/verify", {
      phone: NUMBER,
      otp: sent[0]!.code,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; isNewAccount: boolean };
    expect(body.token).toMatch(/^Bearer /);
    // No name yet, so the client sends them to profile completion rather
    // than a home screen greeting a blank.
    expect(body.isNewAccount).toBe(true);

    // And the number is now an identity.
    const found = await repo.findUserByPhone(E164);
    expect(found?._id).toBe(started.userId);
  });

  it("will not spend the same code twice", async () => {
    /*
     * The burn is guarded on the hash, so a replayed request cannot mint a
     * second session off one code.
     */
    const started = (await (
      await post(start, "/api/users/phone/start", { phone: NUMBER, intent: "signup" })
    ).json()) as { userId: string };
    made.push(started.userId);
    await settle();
    const code = sent[0]!.code;

    expect((await post(verify, "/api/users/phone/verify", { phone: NUMBER, otp: code })).status).toBe(200);
    const again = await post(verify, "/api/users/phone/verify", { phone: NUMBER, otp: code });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a wrong code without saying which way it was wrong", async () => {
    // Telling "wrong" from "expired" from "never sent" is how somebody learns
    // whether a number has a pending signup.
    const started = (await (
      await post(start, "/api/users/phone/start", { phone: NUMBER, intent: "signup" })
    ).json()) as { userId: string };
    made.push(started.userId);
    await settle();

    const res = await post(verify, "/api/users/phone/verify", { phone: NUMBER, otp: "000000" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not right, or it has expired/i);
  });

  it("turns away a number that already has an account", async () => {
    const started = (await (
      await post(start, "/api/users/phone/start", { phone: NUMBER, intent: "signup" })
    ).json()) as { userId: string };
    made.push(started.userId);
    await settle();
    await post(verify, "/api/users/phone/verify", { phone: NUMBER, otp: sent[0]!.code });

    const res = await post(start, "/api/users/phone/start", { phone: NUMBER, intent: "signup" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ACCOUNT_EXISTS");
  });
});

describe("signing in with a number", () => {
  beforeEach(async () => {
    sent.length = 0;
    await cleanup();
  });
  afterAll(cleanup);

  it("does not create an account for an unknown number", async () => {
    /*
     * The rule that matters most here, and the same one applied to Google and
     * Apple: a button that says sign in must not sign anybody up. The client
     * shows the signup screen on this code.
     */
    const before = await repo.countUsers();
    const res = await post(start, "/api/users/phone/start", {
      phone: "03005559999",
      intent: "signin",
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("ACCOUNT_NOT_FOUND");
    await settle();
    expect(sent).toHaveLength(0);
    expect(await repo.countUsers()).toBe(before);
  });

  it("sends a code to a number that does have one", async () => {
    const started = (await (
      await post(start, "/api/users/phone/start", { phone: NUMBER, intent: "signup" })
    ).json()) as { userId: string };
    made.push(started.userId);
    await settle();
    await post(verify, "/api/users/phone/verify", { phone: NUMBER, otp: sent[0]!.code });
    sent.length = 0;

    const res = await post(start, "/api/users/phone/start", { phone: NUMBER, intent: "signin" });
    expect(res.status).toBe(200);
    await settle();
    expect(sent).toHaveLength(1);
  });
});

describe("what it refuses before sending anything", () => {
  it("will not send to a landline", async () => {
    // An OTP cannot reach one, so an account made from it could never sign in.
    sent.length = 0;
    const res = await post(start, "/api/users/phone/start", {
      phone: "02135678901",
      intent: "signup",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NOT_MOBILE");
    await settle();
    expect(sent).toHaveLength(0);
  });
});
