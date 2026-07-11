import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { DealModel } from "@/lib/models";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";

interface RouteParams {
  params: Promise<{ brandId: string; dealId: string }>;
}

// Unlike campaigns, deal status (active/inactive/expired) is the brand's own
// activate/deactivate switch, so "write" members may set it here.
const ALLOWED_FIELDS = new Set([
  "title",
  "description",
  "discountPercentage",
  "discountAmount",
  "promoCode",
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

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED_FIELDS.has(key) && value !== undefined) {
        update[key] = typeof value === "string" ? value.trim() : value;
      }
    }

    if (Object.keys(update).length === 0) {
      return Response.json(
        { success: false, message: "No valid fields provided" },
        { status: 400 },
      );
    }

    const deal = await DealModel.findOneAndUpdate(
      { _id: dealId, brand: brandId },
      { $set: update },
      { new: true, runValidators: true },
    );

    if (!deal) {
      return Response.json(
        { success: false, message: "Deal not found" },
        { status: 404 },
      );
    }

    return Response.json({ success: true, deal });
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
