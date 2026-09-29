/**
 * The dates this household could ask to be collected on.
 *
 * Proxies the operations API, which owns slots. The household is identified
 * from the verified JWT and never from the request, so one user cannot read
 * another's availability — the same rule the invitations and history routes
 * follow, and for the same reason.
 */
import { getAuthenticatedUserId } from "@/lib/auth";
import { listCollectionSlots } from "@/lib/adminApi";

export async function GET(req: Request) {
  const userId = await getAuthenticatedUserId({
    headers: { authorization: req.headers.get("authorization") ?? undefined },
  });
  if (!userId) {
    return Response.json({ error: "You must be signed in." }, { status: 401 });
  }

  const result = await listCollectionSlots(userId);
  if (!result.ok) {
    /*
     * Fail closed on eligibility, open on the list.
     *
     * `eligible: true` with an empty list would have the app say "no dates
     * available in your area", which is a specific claim we cannot make when
     * we could not ask. `unavailable` lets it say the truthful thing instead.
     */
    console.warn(
      "[collections/slots] operations API unavailable:",
      result.error,
    );
    return Response.json({
      Status: "Success",
      eligible: false,
      reason: "unavailable",
      slots: [],
    });
  }

  return Response.json({ Status: "Success", ...result.data });
}
