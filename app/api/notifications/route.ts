/**
 * What this household has been told — the in-app inbox.
 *
 * Proxies the operations API, which owns the notification record. The
 * household is identified from the verified JWT and never from the request,
 * so one user cannot read another's messages by asking.
 */
import { getAuthenticatedUserId } from "@/lib/auth";
import { listNotifications } from "@/lib/adminApi";

export async function GET(req: Request) {
  const userId = await getAuthenticatedUserId({
    headers: { authorization: req.headers.get("authorization") ?? undefined },
  });
  if (!userId) {
    return Response.json({ error: "You must be signed in." }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 30);
  const before = Number(url.searchParams.get("before") ?? 0);

  const result = await listNotifications(userId, {
    limit: Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 30,
    ...(Number.isInteger(before) && before > 0 ? { before } : {}),
  });

  if (!result.ok) {
    // An empty inbox and an unreachable operations API look the same to a
    // person, and neither is something they can act on. Logged so it is not
    // invisible to us.
    console.warn("[notifications] operations API unavailable:", result.error);
    return Response.json({
      Status: "Success",
      notifications: [],
      unread: 0,
      nextBefore: null,
    });
  }

  return Response.json({ Status: "Success", ...result.data });
}
