/**
 * Rounds this household has already been through.
 *
 * Proxies the operations API, which owns collections. The household is
 * identified from the verified JWT and never from the request, so one user
 * cannot read another's history by asking nicely — the same rule the
 * invitations route follows, and for the same reason.
 */
import { getAuthenticatedUserId } from "@/lib/auth";
import { listPastCollections } from "@/lib/adminApi";

export async function GET(req: Request) {
  const userId = await getAuthenticatedUserId({
    headers: { authorization: req.headers.get("authorization") ?? undefined },
  });
  if (!userId) {
    return Response.json({ error: "You must be signed in." }, { status: 401 });
  }

  const limit = Number(new URL(req.url).searchParams.get("limit")) || 20;
  const result = await listPastCollections(userId, limit);
  if (!result.ok) {
    // An empty list rather than an error, as with invitations: a household
    // with no history and a backend that cannot reach operations look
    // identical from the app, and neither is something the person can act
    // on. Logged so it is not invisible to us.
    console.warn("[collections/history] operations API unavailable:", result.error);
    return Response.json({ Status: "Success", collections: [] });
  }

  return Response.json({ Status: "Success", collections: result.data.collections });
}
