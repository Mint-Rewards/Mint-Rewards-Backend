import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";
import { requireBrandAuth } from "@/lib/requireBrandAuth";
import { requireBrandScope } from "@/lib/requireBrandScope";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Fields a brand may update themselves. Status and role are admin-only.
const ALLOWED_FIELDS = new Set([
  "brandName",
  "companyName",
  "description",
  "webLink",
  "appLink",
  "phone",
  "address",
  "domain",
  "themeColor",
  "contactName",
]);

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const auth = requireBrandAuth(req);
    if (auth instanceof NextResponse) return auth;

    const scope = await requireBrandScope(auth.brandUser, id);
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

    const brand = await BrandModel.findByIdAndUpdate(
      id,
      { $set: update },
      { returnDocument: "after", runValidators: true },
    ).select("-verificationToken");

    if (!brand) {
      return Response.json(
        { success: false, message: "Brand not found" },
        { status: 404 },
      );
    }

    return Response.json({ success: true, brand });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
