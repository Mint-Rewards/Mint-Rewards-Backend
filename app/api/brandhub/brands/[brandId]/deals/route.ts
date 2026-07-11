import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { DealModel } from "@/lib/models";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;

    const access = await requireModuleAccess(req, "consumer-reporting", "read");
    if (access instanceof NextResponse) return access;

    const scope = await requireBrandScope(access.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    const deals = await DealModel.find({ brand: brandId })
      .sort({ _id: -1 })
      .lean();

    return Response.json({ success: true, deals, total: deals.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;

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

    const { title } = body;
    if (!title || typeof title !== "string" || title.trim() === "") {
      return Response.json(
        { success: false, message: "title is required" },
        { status: 400 },
      );
    }

    const deal = await DealModel.create({
      brand: brandId,
      title: title.trim(),
      ...(typeof body.description === "string" && { description: body.description }),
      ...(typeof body.discountPercentage === "number" && { discountPercentage: body.discountPercentage }),
      ...(typeof body.discountAmount === "number" && { discountAmount: body.discountAmount }),
      ...(typeof body.promoCode === "string" && body.promoCode && { promoCode: body.promoCode }),
      ...(typeof body.startDate === "string" && body.startDate && { startDate: body.startDate }),
      ...(typeof body.endDate === "string" && body.endDate && { endDate: body.endDate }),
      ...(typeof body.maxUses === "number" && { maxUses: body.maxUses }),
      ...(typeof body.minimumPurchase === "number" && { minimumPurchase: body.minimumPurchase }),
    });

    return Response.json({ success: true, deal }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
