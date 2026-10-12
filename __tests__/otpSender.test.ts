/**
 * Getting a one-time code to a phone, and the guard that stops it going to a
 * log instead.
 *
 * The stand-in sender prints codes, which is the only way this flow can be
 * exercised before the business number exists. The thing worth testing is not
 * that it prints them — it is that it cannot do so on a live system, because
 * a misconfigured production deployment writing customers' one-time codes
 * into a log readable by support, analytics and anybody with log access is a
 * breach rather than a bug.
 */
import { describe, expect, it, jest, beforeEach, afterEach } from "@jest/globals";

let production = false;

jest.mock("../lib/env", () => {
  const actual = jest.requireActual("../lib/env") as { serverEnv: object };
  const mocked = { ...actual.serverEnv };
  Object.defineProperty(mocked, "isProduction", {
    enumerable: true,
    get: () => production,
  });
  return { ...actual, serverEnv: mocked };
});

import {
  LoggingOtpSender,
  WhatsAppCloudSender,
  otpSender,
  setOtpSender,
} from "@/whatsappServices/otpSender";

describe("the stand-in sender", () => {
  beforeEach(() => {
    production = false;
    setOtpSender(null);
  });

  it("reports success so a phone flow can be worked end to end", async () => {
    // Without a provider there is nothing to send to, and the flow still has
    // to be testable — that is the whole reason this exists.
    const sender = new LoggingOtpSender();
    const out = await sender.send("+923001234567", "123456");
    expect(out.ok).toBe(true);
  });

  it("refuses to exist in production", () => {
    /*
     * Loudly, at construction. The alternative is a deployment that is
     * missing its WhatsApp settings appearing to work while writing live
     * codes into a log — which nobody would notice until somebody read one.
     */
    production = true;
    expect(() => new LoggingOtpSender()).toThrow(/never run in production/i);
  });

  it("names what is missing when it refuses", () => {
    // So the person reading the crash knows which variables to set rather
    // than going looking.
    production = true;
    expect(() => new LoggingOtpSender()).toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
  });
});

describe("choosing a sender", () => {
  beforeEach(() => {
    production = false;
    setOtpSender(null);
  });

  it("falls back to the stub when WhatsApp is not configured", () => {
    // Which is every environment today.
    expect(otpSender().name).toBe("logging-stub");
  });

  it("hands back the same one each time", () => {
    expect(otpSender()).toBe(otpSender());
  });

  it("can be replaced, so a test can watch what was sent", () => {
    const fake = { name: "fake", send: async () => ({ ok: true as const, providerId: null }) };
    setOtpSender(fake);
    expect(otpSender()).toBe(fake);
  });
});

describe("the Cloud API sender", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const sender = () => new WhatsAppCloudSender("111", "token", "mint_otp", "en");

  it("sends the number without a leading plus, as Meta wants", async () => {
    let body: Record<string, unknown> = {};
    global.fetch = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.1" }] }) };
    }) as unknown as typeof fetch;

    const out = await sender().send("+923001234567", "123456");
    expect(out).toEqual({ ok: true, providerId: "wamid.1" });
    expect(body.to).toBe("923001234567");
  });

  it("carries the code in the body and in the copy button", () => {
    // Meta rejects an authentication template that omits the button
    // component — as malformed, not as undelivered, so it would look like a
    // code problem rather than a payload one.
    let body: { template?: { components?: { type: string }[] } } = {};
    global.fetch = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as typeof body;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    return sender()
      .send("+923001234567", "654321")
      .then(() => {
        const kinds = (body.template?.components ?? []).map((c) => c.type);
        expect(kinds).toEqual(["body", "button"]);
        expect(JSON.stringify(body)).toContain("654321");
      });
  });

  it("treats a paused template as permanent, not worth retrying", async () => {
    /*
     * A 4xx is ours to fix — a bad token, a paused template, a number Meta
     * will not message. Retrying cannot help, and it would spend the rate
     * limit that protects somebody else's phone.
     */
    global.fetch = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Template is paused" } }),
    })) as unknown as typeof fetch;

    const out = await sender().send("+923001234567", "123456");
    expect(out).toEqual({ ok: false, error: "Template is paused", retryable: false });
  });

  it("treats a server error and a rate limit as worth another go", async () => {
    for (const status of [500, 503, 429]) {
      global.fetch = (async () => ({
        ok: false,
        status,
        json: async () => ({}),
      })) as unknown as typeof fetch;
      const out = await sender().send("+923001234567", "123456");
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.retryable).toBe(true);
    }
  });

  it("treats a network failure as retryable, not as an answer", async () => {
    // A thrown fetch is a tunnel, not a refusal. Anything Meta actually said
    // would have arrived as a status.
    global.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const out = await sender().send("+923001234567", "123456");
    expect(out).toEqual({ ok: false, error: "ECONNRESET", retryable: true });
  });
});
