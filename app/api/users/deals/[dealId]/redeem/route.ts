import { getAuthenticatedUserId } from "@/lib/auth";
import { findBrandById } from "@/lib/repositories/brandhub";
import { claimDealCode, findDealById } from "@/lib/repositories/deals";

interface RouteParams {
  params: Promise<{ dealId: string }>;
}

/**
 * POST /api/users/deals/[dealId]/redeem
 *
 * Claims one promo code from a deal's inventory for the calling user.
 *
 * Unlike campaign coupons — where every user may be handed the same code —
 * a deal's codes are an inventory: each code goes to exactly one user, so the
 * claim has to be atomic. The findOneAndUpdate below both selects the code
 * (by position `currentUses`) and commits the claim in a single guarded
 * update, so two concurrent requests cannot be handed the same code.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { dealId } = await params;

    const userId = await getAuthenticatedUserId({
      headers: { authorization: req.headers.get("authorization") ?? undefined },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const deal = await findDealById(dealId);
    if (!deal || deal.status !== "active") {
      return Response.json({ error: "Deal not found." }, { status: 404 });
    }

    const brand = await findBrandById(deal.brand);
    if (!brand || brand.status !== "APPROVED") {
      return Response.json({ error: "Deal not found." }, { status: 404 });
    }

    // One statement does the whole thing now: it picks the code at the
    // current cursor and commits the claim together, so there is no window to
    // lose and no retry loop. See claimDealCode.
    const outcome = await claimDealCode(dealId, userId);

    switch (outcome.status) {
      case "claimed":
        return Response.json({ code: outcome.code, alreadyClaimed: false });
      // Idempotent: re-opening a claimed deal shows the same code rather than
      // consuming a second one.
      case "already":
        return Response.json({ code: outcome.code, alreadyClaimed: true });
      case "no-codes":
        return Response.json(
          { error: "This deal has no promo codes available." },
          { status: 409 },
        );
      case "exhausted":
        return Response.json(
          { error: "This deal is fully redeemed." },
          { status: 409 },
        );
      default:
        return Response.json({ error: "Deal not found." }, { status: 404 });
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Your request could not be processed. Please try again.";
    return Response.json({ error: message }, { status: 500 });
  }
}
