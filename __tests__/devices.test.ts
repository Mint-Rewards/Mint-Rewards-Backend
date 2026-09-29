/**
 * Device registration for push.
 *
 * The security-relevant decision in this route is that `subjectId` comes from
 * the verified JWT and never from the request body. A client able to name its
 * own subject could subscribe itself to another user's notifications, and no
 * other layer would catch it — the notification service trusts what this
 * backend tells it, because this backend holds the service credential.
 */
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { DELETE, POST } from "@/app/api/devices/route";
import * as notifications from "@/lib/notifications";

const JWT_SECRET =
  process.env.JWT_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  process.env.NEXT_JWT_SECRET ??
  "";

const userId = new mongoose.Types.ObjectId().toString();
const tokenFor = (id: string, extra: Record<string, unknown> = {}) =>
  jwt.sign({ id, ...extra }, JWT_SECRET, { expiresIn: "1h" });

function req(body: unknown, token?: string): Request {
  return new Request("http://localhost/api/devices", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const VALID = { token: "fRQpnQ0-nUmGiQh6FMDYRZ:APA91bExample", platform: "IOS" };

describe("POST /api/devices", () => {
  let register: jest.SpyInstance;

  beforeEach(() => {
    register = jest
      .spyOn(notifications, "registerDevice")
      .mockResolvedValue({ ok: true, status: 201 });
  });
  afterEach(() => jest.restoreAllMocks());

  it("binds the token to the user in the JWT, not one named in the body", async () => {
    // The whole point of the route. A client that could choose its own
    // subjectId could subscribe itself to someone else's notifications.
    const someoneElse = new mongoose.Types.ObjectId().toString();
    const res = await POST(
      req({ ...VALID, subjectId: someoneElse, audience: "ADMIN" }, tokenFor(userId)),
    );

    expect(res.status).toBe(201);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ audience: "USER", subjectId: userId }),
    );
    const sent = register.mock.calls[0][0];
    expect(sent.subjectId).not.toBe(someoneElse);
    expect(sent.audience).not.toBe("ADMIN");
  });

  it("refuses an unauthenticated request", async () => {
    const res = await POST(req(VALID));
    expect(res.status).toBe(401);
    expect(register).not.toHaveBeenCalled();
  });

  it("refuses a token scoped to another purpose", async () => {
    // Password-reset tokens carry `purpose` and must never authenticate a
    // general request — getAuthenticatedUserId rejects them.
    const res = await POST(req(VALID, tokenFor(userId, { purpose: "password-reset" })));
    expect(res.status).toBe(401);
    expect(register).not.toHaveBeenCalled();
  });

  it("rejects a missing or implausible push token", async () => {
    for (const token of [undefined, "", "short", "x".repeat(5000)]) {
      const res = await POST(req({ ...VALID, token }, tokenFor(userId)));
      expect(res.status).toBe(400);
    }
    expect(register).not.toHaveBeenCalled();
  });

  it("rejects an unknown platform", async () => {
    const res = await POST(req({ ...VALID, platform: "BLACKBERRY" }, tokenFor(userId)));
    expect(res.status).toBe(400);
    expect(register).not.toHaveBeenCalled();
  });

  it("accepts a lowercase platform", async () => {
    const res = await POST(req({ ...VALID, platform: "ios" }, tokenFor(userId)));
    expect(res.status).toBe(201);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ platform: "IOS" }));
  });

  it("reports a downstream outage without pretending it worked", async () => {
    // The phone will register again on its next launch; telling it everything
    // is fine would mean it never retries.
    register.mockResolvedValue({ ok: false, error: "connect ECONNREFUSED" });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(req(VALID, tokenFor(userId)));
    expect(res.status).toBe(503);
  });

  it("buckets the rate limit per user, not per IP", async () => {
    // Mobile carriers here put thousands of subscribers behind one CGNAT
    // address. An IP bucket would let one user's loop lock out everyone on
    // their network, for reasons none of them could see or fix.
    const a = new mongoose.Types.ObjectId().toString();
    const b = new mongoose.Types.ObjectId().toString();
    const fromSameIp = (id: string) =>
      new Request("http://localhost/api/devices", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenFor(id)}`,
          "x-forwarded-for": "203.0.113.7",
        },
        body: JSON.stringify(VALID),
      });

    for (let i = 0; i < 12; i += 1) {
      expect((await POST(fromSameIp(a))).status).toBe(201);
    }
    // Same IP, different account — must be unaffected by the first user's use.
    expect((await POST(fromSameIp(b))).status).toBe(201);
  });

  it("rejects a malformed body rather than throwing", async () => {
    const res = await POST(
      new Request("http://localhost/api/devices", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenFor(userId)}`,
        },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/devices", () => {
  afterEach(() => jest.restoreAllMocks());

  it("releases the token on sign-out", async () => {
    const unregister = jest
      .spyOn(notifications, "unregisterDevice")
      .mockResolvedValue({ ok: true });

    const res = await DELETE(
      new Request("http://localhost/api/devices", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenFor(userId)}`,
        },
        body: JSON.stringify({ token: VALID.token }),
      }),
    );

    expect(res.status).toBe(200);
    expect(unregister).toHaveBeenCalledWith(VALID.token);
  });

  it("still succeeds when the notification service is down", async () => {
    // Signing out must never fail because a downstream service blinked. The
    // token is rebound on the next registration anyway.
    jest
      .spyOn(notifications, "unregisterDevice")
      .mockResolvedValue({ ok: false, error: "timeout" });
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const res = await DELETE(
      new Request("http://localhost/api/devices", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenFor(userId)}`,
        },
        body: JSON.stringify({ token: VALID.token }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("refuses an unauthenticated release", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/devices", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: VALID.token }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
