import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { DealModel } from "@/lib/models";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";
import { cleanSuppliedCodes, generateDealCodes } from "@/lib/dealCodes";

interface RouteParams {
  params: Promise<{ brandId: string; dealId: string }>;
}

// Unlike campaigns, an already-approved deal's active/inactive toggle is the
// brand's own switch, so "write" members may set it here — but moving a deal
// out of pending/rejected is still admin-only (enforced below).
const ALLOWED_FIELDS = new Set([
  "title",
  "description",
  "discountPercentage",
  "discountAmount",
  "startDate",
  "endDate",
  "maxUses",
  "minimumPurchase",
  "status",
]);

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId, dealId } = await params;

    const access = await requireModuleAccess(
      req,
      "consumer-reporting",
      "write",
    );
    if (access instanceof NextResponse) return access;

    const scope = await requireBrandScope(access.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { success: false, message: "Invalid JSON body" },
        { status: 400 },
      );
    }

    // Brands may flip an already-approved deal between active/inactive, but
    // can't self-approve out of pending or override a rejection — that's
    // admin-only, via the /api/brands/[id]/deals/[dealId] moderation route.
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "inactive") {
        return Response.json(
          {
            success: false,
            message: "Brands may only toggle status between active and inactive",
          },
          { status: 403 },
        );
      }
      const current = await DealModel.findOne({ _id: dealId, brand: brandId })
        .select("status")
        .lean();
      if (!current) {
        return Response.json(
          { success: false, message: "Deal not found" },
          { status: 404 },
        );
      }
      if (current.status !== "active" && current.status !== "inactive") {
        return Response.json(
          {
            success: false,
            message: "This deal is awaiting admin approval and can't be toggled yet",
          },
          { status: 403 },
        );
      }
    }

    const update: Record<string, unknown> = {};
    if (body.status === "active" || body.status === "inactive") {
      update.status = body.status;
    }
    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED_FIELDS.has(key) && key !== "status" && value !== undefined) {
        update[key] = typeof value === "string" ? value.trim() : value;
      }
    }

    // addCodes appends to the inventory: either a string[] (same rules as
    // POST codes) or { count, prefix? } (same as generateCodes). Codes can
    // never be removed through this route.
    let appendCodes: string[] | null = null;
    if (body.addCodes !== undefined) {
      const existing = await DealModel.findOne({ _id: dealId, brand: brandId })
        .select("codes")
        .lean();
      if (!existing) {
        return Response.json(
          { success: false, message: "Deal not found" },
          { status: 404 },
        );
      }
      const current = existing.codes ?? [];
      const result = Array.isArray(body.addCodes)
        ? cleanSuppliedCodes(body.addCodes, current)
        : generateDealCodes(body.addCodes, current);
      if ("error" in result) {
        return Response.json(
          { success: false, message: result.error },
          { status: 400 },
        );
      }
      appendCodes = result.codes;
      // Backfill promoCode for deals created before the codes field existed.
      if (current.length === 0) {
        update.promoCode = appendCodes[0];
      }
    }

    // A content edit (anything but the active/inactive toggle above) sends an
    // already-live deal back through moderation, same as campaigns. Only a
    // deal that's currently `active` needs this — pending/rejected/inactive
    // deals aren't "live" to begin with, so an edit shouldn't move them.
    if (body.status === undefined && (Object.keys(update).length > 0 || appendCodes)) {
      const current = await DealModel.findOne({ _id: dealId, brand: brandId })
        .select("status")
        .lean();
      if (!current) {
        return Response.json(
          { success: false, message: "Deal not found" },
          { status: 404 },
        );
      }
      if (current.status === "active") {
        update.status = "pending";
      }
    }

    if (Object.keys(update).length === 0 && !appendCodes) {
      return Response.json(
        { success: false, message: "No valid fields provided" },
        { status: 400 },
      );
    }

    const mutation: Record<string, unknown> = {};
    if (Object.keys(update).length > 0) mutation.$set = update;
    if (appendCodes) mutation.$push = { codes: { $each: appendCodes } };

    const deal = await DealModel.findOneAndUpdate(
      { _id: dealId, brand: brandId },
      mutation,
      { new: true, runValidators: true },
    );

    if (!deal) {
      return Response.json(
        { success: false, message: "Deal not found" },
        { status: 404 },
      );
    }

    return Response.json({
      success: true,
      deal: {
        ...deal.toObject(),
        codes: deal.codes ?? [],
        codeCount: deal.codes?.length ?? 0,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId, dealId } = await params;

    // Hard delete with no audit trail — deliberately requires "manage".
    const access = await requireModuleAccess(
      req,
      "consumer-reporting",
      "manage",
    );
    if (access instanceof NextResponse) return access;

    const scope = await requireBrandScope(access.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    const deal = await DealModel.findOneAndDelete({
      _id: dealId,
      brand: brandId,
    });

    if (!deal) {
      return Response.json(
        { success: false, message: "Deal not found" },
        { status: 404 },
      );
    }

    return Response.json({ success: true, message: "Deal deleted" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
