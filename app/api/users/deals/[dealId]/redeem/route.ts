import { Types } from "mongoose";
import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { BrandModel, DealModel } from "@/lib/models";

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

    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: { authorization: req.headers.get("authorization") ?? undefined },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!Types.ObjectId.isValid(dealId)) {
      return Response.json({ error: "Deal not found." }, { status: 404 });
    }

    const userObjectId = new Types.ObjectId(userId);

    const deal = await DealModel.findById(dealId).lean();
    if (!deal || deal.status !== "active") {
      return Response.json({ error: "Deal not found." }, { status: 404 });
    }

    const brand = await BrandModel.findById(deal.brand).select("status").lean();
    if (!brand || brand.status !== "APPROVED") {
      return Response.json({ error: "Deal not found." }, { status: 404 });
    }

    // Returning the existing code keeps this idempotent: a user re-opening a
    // claimed deal sees their code again rather than consuming a second one.
    const existing = (deal.claims ?? []).find(
      (c) => c.user?.toString() === userId,
    );
    if (existing) {
      return Response.json({ code: existing.code, alreadyClaimed: true });
    }

    const codes = deal.codes ?? [];
    if (codes.length === 0) {
      return Response.json(
        { error: "This deal has no promo codes available." },
        { status: 409 },
      );
    }

    // Retry on lost races: each attempt targets the next unclaimed position,
    // and the `currentUses` guard makes a stale attempt match nothing.
    for (let attempt = 0; attempt < 5; attempt++) {
      const fresh = await DealModel.findById(dealId)
        .select("currentUses codes maxUses")
        .lean();
      if (!fresh) {
        return Response.json({ error: "Deal not found." }, { status: 404 });
      }

      const index = fresh.currentUses ?? 0;
      const cap =
        typeof fresh.maxUses === "number"
          ? Math.min(fresh.maxUses, (fresh.codes ?? []).length)
          : (fresh.codes ?? []).length;

      if (index >= cap) {
        return Response.json(
          { error: "This deal is fully redeemed." },
          { status: 409 },
        );
      }

      const code = (fresh.codes ?? [])[index];

      const committed = await DealModel.findOneAndUpdate(
        {
          _id: dealId,
          status: "active",
          currentUses: index,
          users: { $ne: userObjectId },
        },
        {
          $inc: { currentUses: 1 },
          $addToSet: { users: userObjectId },
          $push: {
            claims: { user: userObjectId, code, claimedAt: new Date() },
          },
        },
        { new: true },
      ).lean();

      if (committed) {
        return Response.json({ code, alreadyClaimed: false });
      }
    }

    return Response.json(
      { error: "Could not claim a code right now. Please try again." },
      { status: 503 },
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Your request could not be processed. Please try again.";
    return Response.json({ error: message }, { status: 500 });
  }
}
