/**
 * The household's own view of, and answer to, a collection invitation.
 *
 * Both routes proxy the operations API, which owns collections. The decision
 * worth pinning is the same one /api/devices makes: the household is taken
 * from the verified JWT and never from the request, so nobody can read or
 * answer for another.
 */
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { GET as invitationsGet } from "@/app/api/collections/invitations/route";
import { POST as respondPost } from "@/app/api/collections/[collectionId]/respond/route";
import * as adminApi from "@/lib/adminApi";

const JWT_SECRET =
  process.env.JWT_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  process.env.NEXT_JWT_SECRET ??
  "";

const userId = new mongoose.Types.ObjectId().toString();
const tokenFor = (id: string) => jwt.sign({ id }, JWT_SECRET, { expiresIn: "1h" });

const INVITATION = {
  collectionId: 25,
  name: "Saturday run",
  scheduledDate: "2026-09-23",
  timeSlot: "MORNING",
  responseDeadlineAt: "2026-09-22T12:00:00.000Z",
  status: "INVITED" as const,
  invitedAt: "2026-09-21T12:00:00.000Z",
  respondedAt: null,
  captainName: "Imran Baig",
  captainAvatar: null,
};

const get = (token?: string) =>
  new Request("http://localhost/api/collections/invitations", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const post = (token: string | undefined, body: unknown, id = "25") => ({
  req: new Request(`http://localhost/api/collections/${id}/respond`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }),
  ctx: { params: Promise.resolve({ collectionId: id }) },
});

describe("GET /api/collections/invitations", () => {
  afterEach(() => jest.restoreAllMocks());

  it("asks for the household in the JWT", async () => {
    const list = jest
      .spyOn(adminApi, "listInvitations")
      .mockResolvedValue({ ok: true, data: { invitations: [INVITATION] } });

    const res = await invitationsGet(get(tokenFor(userId)));
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(userId);
    expect((await res.json()).invitations).toHaveLength(1);
  });

  it("refuses an unauthenticated request", async () => {
    const list = jest.spyOn(adminApi, "listInvitations");
    expect((await invitationsGet(get())).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("shows an empty list when operations is unreachable", async () => {
    // A household with nothing pending and a backend that cannot reach
    // operations look identical from the app, and neither is something the
    // person can act on — so the app is not shown an error it cannot use.
    jest.spyOn(adminApi, "listInvitations").mockResolvedValue({ ok: false, error: "ECONNREFUSED" });
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const res = await invitationsGet(get(tokenFor(userId)));
    expect(res.status).toBe(200);
    expect((await res.json()).invitations).toEqual([]);
  });
});

describe("POST /api/collections/[collectionId]/respond", () => {
  afterEach(() => jest.restoreAllMocks());

  it("records the answer against the user in the JWT", async () => {
    const respond = jest
      .spyOn(adminApi, "respondToInvitation")
      .mockResolvedValue({ ok: true, data: { collectionId: 25, status: "ACCEPTED" } });

    const { req, ctx } = post(tokenFor(userId), { response: "ACCEPTED" });
    const res = await respondPost(req, ctx);

    expect(res.status).toBe(200);
    expect(respond).toHaveBeenCalledWith(userId, 25, "ACCEPTED");
  });

  it("accepts a lowercase answer", async () => {
    const respond = jest
      .spyOn(adminApi, "respondToInvitation")
      .mockResolvedValue({ ok: true, data: { collectionId: 25, status: "DECLINED" } });
    const { req, ctx } = post(tokenFor(userId), { response: "declined" });
    expect((await respondPost(req, ctx)).status).toBe(200);
    expect(respond).toHaveBeenCalledWith(userId, 25, "DECLINED");
  });

  it("rejects anything that is not an answer", async () => {
    const respond = jest.spyOn(adminApi, "respondToInvitation");
    for (const response of [undefined, "", "MAYBE", 1]) {
      const { req, ctx } = post(tokenFor(userId), { response });
      expect((await respondPost(req, ctx)).status).toBe(400);
    }
    expect(respond).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated answer", async () => {
    const respond = jest.spyOn(adminApi, "respondToInvitation");
    const { req, ctx } = post(undefined, { response: "ACCEPTED" });
    expect((await respondPost(req, ctx)).status).toBe(401);
    expect(respond).not.toHaveBeenCalled();
  });

  it("passes through a closed window rather than flattening it", async () => {
    // "You are too late" is something the person can understand and act on;
    // a generic 503 is not.
    jest.spyOn(adminApi, "respondToInvitation").mockResolvedValue({
      ok: false,
      status: 409,
      error: "This collection is no longer taking answers.",
    });
    const { req, ctx } = post(tokenFor(userId), { response: "ACCEPTED" });
    const res = await respondPost(req, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no longer taking/i);
  });

  it("reports an outage as an outage", async () => {
    jest
      .spyOn(adminApi, "respondToInvitation")
      .mockResolvedValue({ ok: false, error: "ECONNREFUSED" });
    const { req, ctx } = post(tokenFor(userId), { response: "ACCEPTED" });
    expect((await respondPost(req, ctx)).status).toBe(503);
  });
});
