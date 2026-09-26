/**
 * The household asking to be collected on a date of its choosing.
 *
 * Three routes, all proxying the operations API, which owns slots. The
 * decision worth pinning is the one every household route here makes: the
 * user is taken from the verified JWT and never from the request, so nobody
 * can ask for, or withdraw, on somebody else's behalf.
 *
 * The other is the split in failure handling. A read that cannot reach
 * operations answers with something the app can render honestly; a WRITE
 * must never be swallowed, because a person tapped a button and a silent
 * success leaves them expecting a van we know nothing about.
 */
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { GET as slotsGet } from "@/app/api/collections/slots/route";
import { POST as requestPost } from "@/app/api/collections/slots/[slotId]/request/route";
import { DELETE as withdrawDelete } from "@/app/api/collections/slot-requests/[requestId]/route";
import * as adminApi from "@/lib/adminApi";

const JWT_SECRET =
  process.env.JWT_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  process.env.NEXT_JWT_SECRET ??
  "";

const userId = new mongoose.Types.ObjectId().toString();
const tokenFor = (id: string) => jwt.sign({ id }, JWT_SECRET, { expiresIn: "1h" });

const SLOT = {
  id: 7,
  zoneId: 3,
  zoneName: "Gulshan",
  city: "Karachi",
  date: "2026-10-06",
  timeSlot: "AFTERNOON" as const,
  pendingCount: 4,
  requestThreshold: 20,
  myRequestId: null,
  myStatus: null,
};

const getReq = (token?: string) =>
  new Request("http://localhost/api/collections/slots", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const postReq = (token: string | undefined, slotId = "7") => ({
  req: new Request(`http://localhost/api/collections/slots/${slotId}/request`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }),
  ctx: { params: Promise.resolve({ slotId }) },
});

const deleteReq = (token: string | undefined, requestId = "11") => ({
  req: new Request(`http://localhost/api/collections/slot-requests/${requestId}`, {
    method: "DELETE",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }),
  ctx: { params: Promise.resolve({ requestId }) },
});

describe("GET /api/collections/slots", () => {
  afterEach(() => jest.restoreAllMocks());

  it("asks for the household in the JWT", async () => {
    const list = jest
      .spyOn(adminApi, "listCollectionSlots")
      .mockResolvedValue({ ok: true, data: { eligible: true, slots: [SLOT] } });

    const res = await slotsGet(getReq(tokenFor(userId)));
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(userId);
    expect((await res.json()).slots).toEqual([SLOT]);
  });

  it("turns away a caller with no token", async () => {
    const list = jest.spyOn(adminApi, "listCollectionSlots");
    const res = await slotsGet(getReq());
    expect(res.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("passes through the reason a household cannot book", async () => {
    // "no_pin" is the only one the app can act on, and acting on it means
    // sending them to the map. Flattening it would lose that.
    jest.spyOn(adminApi, "listCollectionSlots").mockResolvedValue({
      ok: true,
      data: { eligible: false, reason: "no_pin", slots: [] },
    });

    const body = await (await slotsGet(getReq(tokenFor(userId)))).json();
    expect(body.eligible).toBe(false);
    expect(body.reason).toBe("no_pin");
  });

  it("does not claim there are no dates when it could not ask", async () => {
    /*
     * `eligible: true` with an empty list is a specific claim — "we have
     * nothing available in your area" — and we cannot make it when
     * operations did not answer. The app has to be able to say the
     * truthful, different thing.
     */
    jest
      .spyOn(adminApi, "listCollectionSlots")
      .mockResolvedValue({ ok: false, error: "down" });
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const res = await slotsGet(getReq(tokenFor(userId)));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.eligible).toBe(false);
    expect(body.reason).toBe("unavailable");
    expect(body.slots).toEqual([]);
  });
});

describe("POST /api/collections/slots/:slotId/request", () => {
  afterEach(() => jest.restoreAllMocks());

  it("asks on behalf of the JWT's household, not a named one", async () => {
    const ask = jest
      .spyOn(adminApi, "requestCollectionSlot")
      .mockResolvedValue({ ok: true, data: { request: { id: 11, status: "PENDING" } } });

    const { req, ctx } = postReq(tokenFor(userId));
    const res = await requestPost(req, ctx);
    expect(res.status).toBe(201);
    expect(ask).toHaveBeenCalledWith(userId, 7);
  });

  it("turns away a caller with no token", async () => {
    const ask = jest.spyOn(adminApi, "requestCollectionSlot");
    const { req, ctx } = postReq(undefined);
    expect((await requestPost(req, ctx)).status).toBe(401);
    expect(ask).not.toHaveBeenCalled();
  });

  it("passes operations' refusal through with its own status", async () => {
    /*
     * These refusals are ones the person can act on: no map pin, already
     * booked that day, the slot closed. Flattening them into a 500 turns
     * every one into "something went wrong" and strands them.
     */
    jest.spyOn(adminApi, "requestCollectionSlot").mockResolvedValue({
      ok: false,
      status: 409,
      error: "You already have a collection booked for that day.",
    });

    const { req, ctx } = postReq(tokenFor(userId));
    const res = await requestPost(req, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already have a collection/);
  });

  it("does not report success when operations could not be reached", async () => {
    // The whole point of not failing open on a write.
    jest
      .spyOn(adminApi, "requestCollectionSlot")
      .mockResolvedValue({ ok: false, error: "timeout" });

    const { req, ctx } = postReq(tokenFor(userId));
    expect((await requestPost(req, ctx)).status).toBe(502);
  });

  it("rejects a slot id that is not one", async () => {
    const ask = jest.spyOn(adminApi, "requestCollectionSlot");
    const { req, ctx } = postReq(tokenFor(userId), "not-a-number");
    expect((await requestPost(req, ctx)).status).toBe(400);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/collections/slot-requests/:requestId", () => {
  afterEach(() => jest.restoreAllMocks());

  it("withdraws on behalf of the JWT's household", async () => {
    const drop = jest
      .spyOn(adminApi, "withdrawCollectionSlotRequest")
      .mockResolvedValue({ ok: true, data: { withdrawn: true } });

    const { req, ctx } = deleteReq(tokenFor(userId));
    expect((await withdrawDelete(req, ctx)).status).toBe(200);
    expect(drop).toHaveBeenCalledWith(userId, 11);
  });

  it("turns away a caller with no token", async () => {
    const drop = jest.spyOn(adminApi, "withdrawCollectionSlotRequest");
    const { req, ctx } = deleteReq(undefined);
    expect((await withdrawDelete(req, ctx)).status).toBe(401);
    expect(drop).not.toHaveBeenCalled();
  });

  it("passes through the refusal when a drive is already arranged", async () => {
    jest.spyOn(adminApi, "withdrawCollectionSlotRequest").mockResolvedValue({
      ok: false,
      status: 409,
      error: "A collection has already been arranged for this.",
    });

    const { req, ctx } = deleteReq(tokenFor(userId));
    const res = await withdrawDelete(req, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already been arranged/);
  });
});
