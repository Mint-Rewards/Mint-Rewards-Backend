/**
 * The household's answer to an invitation.
 *
 * The answer is theirs, so it is recorded against the user in the JWT. The
 * collection id comes from the path, and the operations API checks that this
 * household is actually on that collection — a check that must not live here,
 * because only it knows.
 */
import { getAuthenticatedUserId } from "@/lib/auth";
import { respondToInvitation } from "@/lib/adminApi";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ collectionId: string }> },
) {
  const userId = await getAuthenticatedUserId({
    headers: { authorization: req.headers.get("authorization") ?? undefined },
  });
  if (!userId) {
    return Response.json({ error: "You must be signed in." }, { status: 401 });
  }

  // Per user, for the same reason device registration is: an IP bucket is
  // shared by everyone behind a carrier's NAT.
  const limit = await checkRateLimit("collection-response:user", userId, 40, 15 * 60 * 1000);
  if (limit.limited) return rateLimitResponse(limit.retryAfterSeconds);

  const collectionId = Number((await params).collectionId);
  if (!Number.isInteger(collectionId) || collectionId < 1) {
    return Response.json({ error: "Unknown collection." }, { status: 400 });
  }

  let body: { response?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const response = String(body.response ?? "").toUpperCase();
  if (response !== "ACCEPTED" && response !== "DECLINED") {
    return Response.json({ error: "response must be ACCEPTED or DECLINED." }, { status: 400 });
  }

  const result = await respondToInvitation(userId, collectionId, response);
  if (!result.ok) {
    // 409 and 404 are meaningful to the person — the window closed, or this is
    // not their collection — so they are passed through rather than flattened.
    const status = result.status === 404 || result.status === 409 ? result.status : 503;
    return Response.json({ error: result.error }, { status });
  }

  return Response.json({ Status: "Success", ...result.data });
}
