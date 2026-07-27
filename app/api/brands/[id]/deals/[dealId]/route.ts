import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { DealModel } from "@/lib/models";
import { requireAdminAuth } from "@/lib/requireAdminAuth";
import { requireBrandAuth } from "@/lib/requireBrandAuth";
import { requireBrandScope } from "@/lib/requireBrandScope";

interface RouteParams {
  params: Promise<{ id: string; dealId: string }>;
}

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
    const { id, dealId } = await params;

    // Admins moderate any brand's deals without holding brand-org
    // credentials for that brand; everyone else must own the brand.
    const isAdmin = !(requireAdminAuth(req) instanceof NextResponse);
    if (!isAdmin) {
      const auth = requireBrandAuth(req);
      if (auth instanceof NextResponse) return auth;

      const scope = await requireBrandScope(auth.brandUser, id);
      if (scope instanceof NextResponse) return scope;
    }

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

    if ("status" in body) {
      const auth = requireAdminAuth(req);
      if (auth instanceof NextResponse) return auth;
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
      { _id: dealId, brand: id },
      { $set: update },
      { returnDocument: "after", runValidators: true },
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
    const { id, dealId } = await params;

    const auth = requireBrandAuth(req);
    if (auth instanceof NextResponse) return auth;

    const scope = await requireBrandScope(auth.brandUser, id);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    const deal = await DealModel.findOneAndDelete({ _id: dealId, brand: id });

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
