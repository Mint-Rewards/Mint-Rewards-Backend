/**
 * Putting this household's hand up for a date.
 *
 * Unlike the read routes next door, a failure here must NOT be swallowed.
 * Someone tapped a button and is waiting to be told whether it worked; a
 * silent success would leave them expecting a van we know nothing about.
 */
import { getAuthenticatedUserId } from "@/lib/auth";
import { requestCollectionSlot } from "@/lib/adminApi";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slotId: string }> },
) {
  const userId = await getAuthenticatedUserId({
    headers: { authorization: req.headers.get("authorization") ?? undefined },
  });
  if (!userId) {
    return Response.json({ error: "You must be signed in." }, { status: 401 });
  }

  const slotId = Number((await params).slotId);
  if (!Number.isInteger(slotId) || slotId <= 0) {
    return Response.json(
      { error: "Unknown collection date." },
      { status: 400 },
    );
  }

  const result = await requestCollectionSlot(userId, slotId);
  if (!result.ok) {
    /*
     * Operations' own words, and its own status, passed through.
     *
     * The refusals here are ones the person can act on — no map pin, already
     * booked that day, the slot filled up — and flattening them into a
     * generic 500 would turn every one of them into "something went wrong".
     * 502 only when there was no answer to pass on.
     */
    return Response.json(
      { error: result.error },
      { status: result.status ?? 502 },
    );
  }

  return Response.json({ Status: "Success", ...result.data }, { status: 201 });
}
