import { NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";
import { requireBrandAuth } from "@/lib/requireBrandAuth";
import { requireBrandScope } from "@/lib/requireBrandScope";

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

// Fields a brand may update themselves (parity with legacy
// PATCH /api/brands/[id]/settings). Status and role are admin-only.
const SETTINGS_FIELDS = new Set([
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

/**
 * GET /api/brandhub/brands/[brandId]
 * Fetches one brand through the full chain: requireBrandAuth ->
 * requireBrandScope. This is the endpoint the frontend dashboard migrates
 * to from the unauthenticated /brands/:id.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { brandId } = await params;

  const auth = requireBrandAuth(req);
  if (auth instanceof NextResponse) return auth;

  const scope = await requireBrandScope(auth.brandUser, brandId);
  if (scope instanceof NextResponse) return scope;

  await connectToDatabase();

  const brand = await BrandModel.findById(brandId)
    .select("-verificationToken")
    .lean();

  if (!brand) {
    return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  }

  return NextResponse.json({
    brand: {
      id: brand._id.toString(),
      orgId: brand.orgId?.toString() ?? null,
      brandName: brand.brandName,
      companyName: brand.companyName,
      email: brand.email,
      logo: brand.logo ?? null,
      themeImage: brand.themeImage ?? null,
      category: brand.category,
      description: brand.description ?? "",
      address: brand.address ?? "",
      webLink: brand.webLink,
      appLink: brand.appLink ?? "",
      domain: brand.domain ?? "",
      themeColor: brand.themeColor ?? null,
      status: brand.status ?? null,
    },
  });
}

/**
 * PATCH /api/brandhub/brands/[brandId]
 * Brand profile/theme updates. Settings is not a module — no module gate,
 * but restricted to org owners and admins (members cannot edit the profile).
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;

    const auth = requireBrandAuth(req);
    if (auth instanceof NextResponse) return auth;

    const scope = await requireBrandScope(auth.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    const { orgRole } = auth.brandUser;
    if (orgRole !== "owner" && orgRole !== "admin") {
      return NextResponse.json(
        { error: "Only org owners and admins can edit brand settings" },
        { status: 403 },
      );
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

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (SETTINGS_FIELDS.has(key) && value !== undefined) {
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
      brandId,
      { $set: update },
      { new: true, runValidators: true },
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
