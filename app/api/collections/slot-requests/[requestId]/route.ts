/**
 * Taking a request back.
 *
 * Operations decides whether it still can be — once a drive has been
 * scheduled around this household, dropping out is a cancellation of a real
 * round with a captain assigned, and that goes through the invitation flow.
 * The refusal is passed through rather than reinterpreted here.
 */
import { getAuthenticatedUserId } from "@/lib/auth";
import { withdrawCollectionSlotRequest } from "@/lib/adminApi";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const userId = await getAuthenticatedUserId({
    headers: { authorization: req.headers.get("authorization") ?? undefined },
  });
  if (!userId) {
    return Response.json({ error: "You must be signed in." }, { status: 401 });
  }

  const requestId = Number((await params).requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return Response.json({ error: "Unknown request." }, { status: 400 });
  }

  const result = await withdrawCollectionSlotRequest(userId, requestId);
  if (!result.ok) {
    return Response.json(
      { error: result.error },
      { status: result.status ?? 502 },
    );
  }

  return Response.json({ Status: "Success", ...result.data });
}
