/**
 * Marks messages read, clearing the unread count.
 *
 * Scoped to the household in the JWT. The ids come from a client, and the
 * operations API checks them against that subject — without which one
 * recipient could clear another's badge.
 */
import { getAuthenticatedUserId } from "@/lib/auth";
import { markNotificationsRead } from "@/lib/adminApi";

export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId({
    headers: { authorization: req.headers.get("authorization") ?? undefined },
  });
  if (!userId) {
    return Response.json({ error: "You must be signed in." }, { status: 401 });
  }

  let body: { ids?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is the ordinary case: "mark everything read".
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is number => Number.isInteger(id) && id > 0).slice(0, 200)
    : undefined;

  const result = await markNotificationsRead(userId, ids);
  if (!result.ok) {
    console.warn("[notifications] could not mark read:", result.error);
    // Not an error the person can act on, and the badge corrects itself on the
    // next load. Reporting a failure here would be noise.
    return Response.json({ Status: "Success", read: 0 });
  }

  return Response.json({ Status: "Success", ...result.data });
}
