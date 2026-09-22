/**
 * The in-app inbox.
 *
 * Same decision as every other proxied route here: the household comes from
 * the verified JWT, never from the request, so nobody can read or clear
 * another person's messages.
 */
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { GET as inboxGet } from "@/app/api/notifications/route";
import { POST as readPost } from "@/app/api/notifications/read/route";
import * as adminApi from "@/lib/adminApi";

const JWT_SECRET =
  process.env.JWT_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  process.env.NEXT_JWT_SECRET ??
  "";

const userId = new mongoose.Types.ObjectId().toString();
const tokenFor = (id: string) => jwt.sign({ id }, JWT_SECRET, { expiresIn: "1h" });

const INBOX = {
  notifications: [
    {
      id: 9,
      event: "collection.cancelled",
      title: "Collection cancelled",
      body: "Tomorrow is off.",
      data: { collectionId: "25" },
      createdAt: "2026-09-22T00:00:00.000Z",
      readAt: null,
    },
  ],
  unread: 1,
  nextBefore: null,
};

const get = (token?: string, query = "") =>
  new Request(`http://localhost/api/notifications${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const post = (token?: string, body?: unknown) =>
  new Request("http://localhost/api/notifications/read", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("GET /api/notifications", () => {
  afterEach(() => jest.restoreAllMocks());

  it("asks for the household in the JWT", async () => {
    const list = jest.spyOn(adminApi, "listNotifications").mockResolvedValue({ ok: true, data: INBOX });
    const res = await inboxGet(get(tokenFor(userId)));

    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(userId, expect.objectContaining({ limit: 30 }));
    const body = await res.json();
    expect(body.notifications).toHaveLength(1);
    expect(body.unread).toBe(1);
  });

  it("passes a page cursor through", async () => {
    const list = jest.spyOn(adminApi, "listNotifications").mockResolvedValue({ ok: true, data: INBOX });
    await inboxGet(get(tokenFor(userId), "?limit=10&before=42"));
    expect(list).toHaveBeenCalledWith(userId, { limit: 10, before: 42 });
  });

  it("ignores an implausible limit rather than forwarding it", async () => {
    const list = jest.spyOn(adminApi, "listNotifications").mockResolvedValue({ ok: true, data: INBOX });
    await inboxGet(get(tokenFor(userId), "?limit=9999"));
    expect(list).toHaveBeenCalledWith(userId, { limit: 30 });
  });

  it("refuses an unauthenticated read", async () => {
    const list = jest.spyOn(adminApi, "listNotifications");
    expect((await inboxGet(get())).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("shows an empty inbox when operations is unreachable", async () => {
    // Indistinguishable from having no messages, and neither is something the
    // person can act on — so the app is not shown an error it cannot use.
    jest.spyOn(adminApi, "listNotifications").mockResolvedValue({ ok: false, error: "ECONNREFUSED" });
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const res = await inboxGet(get(tokenFor(userId)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notifications).toEqual([]);
    expect(body.unread).toBe(0);
  });
});

describe("POST /api/notifications/read", () => {
  afterEach(() => jest.restoreAllMocks());

  it("marks everything read when no ids are given", async () => {
    const mark = jest.spyOn(adminApi, "markNotificationsRead").mockResolvedValue({ ok: true, data: { read: 3 } });
    const res = await readPost(post(tokenFor(userId), {}));
    expect(res.status).toBe(200);
    expect(mark).toHaveBeenCalledWith(userId, undefined);
    expect((await res.json()).read).toBe(3);
  });

  it("marks only the ids it was given", async () => {
    const mark = jest.spyOn(adminApi, "markNotificationsRead").mockResolvedValue({ ok: true, data: { read: 2 } });
    await readPost(post(tokenFor(userId), { ids: [9, 10] }));
    expect(mark).toHaveBeenCalledWith(userId, [9, 10]);
  });

  it("drops ids that are not ids", async () => {
    const mark = jest.spyOn(adminApi, "markNotificationsRead").mockResolvedValue({ ok: true, data: { read: 1 } });
    await readPost(post(tokenFor(userId), { ids: [9, "nine", -1, null, 1.5] }));
    expect(mark).toHaveBeenCalledWith(userId, [9]);
  });

  it("treats an empty body as mark-everything", async () => {
    // The ordinary case: opening the tab clears the badge.
    const mark = jest.spyOn(adminApi, "markNotificationsRead").mockResolvedValue({ ok: true, data: { read: 0 } });
    const res = await readPost(post(tokenFor(userId)));
    expect(res.status).toBe(200);
    expect(mark).toHaveBeenCalledWith(userId, undefined);
  });

  it("refuses an unauthenticated clear", async () => {
    const mark = jest.spyOn(adminApi, "markNotificationsRead");
    expect((await readPost(post(undefined, {}))).status).toBe(401);
    expect(mark).not.toHaveBeenCalled();
  });

  it("does not report a failure the person cannot act on", async () => {
    // The badge corrects itself on the next load; an error here is noise.
    jest.spyOn(adminApi, "markNotificationsRead").mockResolvedValue({ ok: false, error: "timeout" });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await readPost(post(tokenFor(userId), {}));
    expect(res.status).toBe(200);
    expect((await res.json()).read).toBe(0);
  });
});
