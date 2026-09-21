/**
 * The collections this household has been asked about, and not yet passed.
 *
 * Proxies the operations API, which owns collections. The household is
 * identified from the verified JWT and never from the request, so one user
 * cannot read another's invitations by asking nicely.
 */
import { getAuthenticatedUserId } from "@/lib/auth";
import { listInvitations } from "@/lib/adminApi";

export async function GET(req: Request) {
  const userId = await getAuthenticatedUserId({
    headers: { authorization: req.headers.get("authorization") ?? undefined },
  });
  if (!userId) {
    return Response.json({ error: "You must be signed in." }, { status: 401 });
  }

  const result = await listInvitations(userId);
  if (!result.ok) {
    // An empty list rather than an error: a household with no pending
    // invitation and a backend that cannot reach operations look identical
    // from the app, and neither is something the person can act on. The
    // failure is logged so it is not invisible to us.
    console.warn("[invitations] operations API unavailable:", result.error);
    return Response.json({ Status: "Success", invitations: [] });
  }

  return Response.json({ Status: "Success", invitations: result.data.invitations });
}
