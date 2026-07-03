import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel, DealModel } from "@/lib/models";
import { requireBrandAuth } from "@/lib/requireBrandAuth";
import { requireBrandScope } from "@/lib/requireBrandScope";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const auth = requireBrandAuth(req);
    if (auth instanceof NextResponse) return auth;

    const scope = await requireBrandScope(auth.brandUser, id);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    const brand = await BrandModel.findById(id).lean();
    if (!brand) {
      return Response.json(
        { success: false, message: "Brand not found" },
        { status: 404 },
      );
    }

    const deals = await DealModel.find({ brand: id }).sort({ _id: -1 }).lean();

    return Response.json({ success: true, deals, total: deals.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const auth = requireBrandAuth(req);
    if (auth instanceof NextResponse) return auth;

    const scope = await requireBrandScope(auth.brandUser, id);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    const brand = await BrandModel.findById(id).lean();
    if (!brand) {
      return Response.json(
        { success: false, message: "Brand not found" },
        { status: 404 },
      );
    }

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
      brand: id,
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
