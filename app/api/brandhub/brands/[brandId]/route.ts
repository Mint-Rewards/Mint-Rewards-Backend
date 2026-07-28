import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";
import { requireBrandAuth } from "@/lib/requireBrandAuth";
import { requireBrandScope } from "@/lib/requireBrandScope";
import { serverEnv } from "@/lib/env";

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB — matches registration's limit

// Fields a brand may update themselves (parity with legacy
// PATCH /api/brands/[id]/settings). Status and role are admin-only.
// `logo` rides in via multipart and is handled separately, not through this
// generic pass-through.
const SETTINGS_FIELDS = new Set([
  "brandName",
  "companyName",
  "email",
  "category",
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
      contactName: brand.contactName ?? "",
      phone: brand.phone ?? "",
      logo: brand.logo ?? null,
      themeImage: brand.themeImage ?? null,
      category: brand.category,
      registrationNumber: brand.registrationNumber,
      description: brand.description ?? "",
      address: brand.address ?? "",
      webLink: brand.webLink,
      appLink: brand.appLink ?? "",
      domain: brand.domain ?? "",
      themeColor: brand.themeColor ?? null,
      status: brand.status ?? null,
      createdAt: brand.createdAt ?? brand._id.getTimestamp(),
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
    let logoFile: File | null = null;

    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const formData = await req.formData().catch(() => null);
      if (!formData) {
        return Response.json(
          { success: false, message: "Invalid form data" },
          { status: 400 },
        );
      }
      for (const [key, value] of formData.entries()) {
        if (key !== "logo") body[key] = value;
      }
      const logo = formData.get("logo");
      if (logo instanceof File && logo.size > 0) logoFile = logo;
    } else {
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { success: false, message: "Invalid JSON body" },
          { status: 400 },
        );
      }
    }

    let logoUrl: string | null = null;
    if (logoFile) {
      if (!logoFile.type.startsWith("image/")) {
        return Response.json(
          { success: false, message: "Logo must be an image file" },
          { status: 400 },
        );
      }
      if (logoFile.size > MAX_LOGO_BYTES) {
        return Response.json(
          { success: false, message: "Logo must be 5MB or smaller" },
          { status: 400 },
        );
      }
      const extension = logoFile.name.includes(".")
        ? `.${logoFile.name.split(".").pop()?.toLowerCase()}`
        : "";
      const blob = await put(
        `brands/${brandId}/logo-${Date.now()}${extension || ".png"}`,
        Buffer.from(await logoFile.arrayBuffer()),
        {
          access: "public",
          contentType: logoFile.type || "application/octet-stream",
          token: serverEnv.blobReadWriteToken,
        },
      );
      logoUrl = blob.url;
    }

    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (SETTINGS_FIELDS.has(key) && value !== undefined) {
        // Lowercase email specifically, matching BrandUser.email's own
        // normalization, so the unique index and any case-sensitive lookups
        // stay consistent.
        update[key] =
          typeof value === "string"
            ? key === "email"
              ? value.trim().toLowerCase()
              : value.trim()
            : value;
      }
    }
    if (logoUrl) update.logo = logoUrl;

    if (Object.keys(update).length === 0) {
      return Response.json(
        { success: false, message: "No valid fields provided" },
        { status: 400 },
      );
    }

    let brand;
    try {
      brand = await BrandModel.findByIdAndUpdate(
        brandId,
        { $set: update },
        { returnDocument: "after", runValidators: true },
      ).select("-verificationToken");
    } catch (error: unknown) {
      // Duplicate key on the unique `email` index — surface as a clean 409
      // instead of the raw Mongo error.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: number }).code === 11000
      ) {
        return Response.json(
          { success: false, message: "Email already in use" },
          { status: 409 },
        );
      }
      throw error;
    }

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
