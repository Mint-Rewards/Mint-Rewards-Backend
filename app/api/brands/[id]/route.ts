import { NextResponse, type NextRequest } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel } from "@/lib/models";
import { requireAdminAuth } from "@/lib/requireAdminAuth";
import { uploadBrandLogo, isLogoUploadError } from "@/lib/brandLogoUpload";

interface RouteParams {
  params: Promise<{
    id: string;
  }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    await connectToDatabase();

    const { id } = await params;

    const brand = await BrandModel.findById(id);

    if (!brand) {
      return Response.json(
        { success: false, message: "Brand not found" },
        { status: 404 },
      );
    }

    return Response.json({ success: true, brand });
  } catch (error: any) {
    return Response.json(
      {
        success: false,
        message: "Server error",
        error: error?.message || "Unexpected error",
      },
      { status: 500 },
    );
  }
}

// Profile fields an admin may overwrite on any brand. Parity with the
// brand-side SETTINGS_FIELDS in /api/brandhub/brands/[brandId] so admin and
// brand editing stay in sync. Identity/derived fields (registrationNumber,
// role, emailVerified, verificationToken, orgId, timestamps) are never
// writable here; `status` is handled separately by the moderation path below.
const ADMIN_EDITABLE_FIELDS = new Set([
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

const VALID_STATUSES = ["APPROVED", "REJECTED"];

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = requireAdminAuth(req);
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;

    let body: Record<string, unknown> = {};
    let logoFile: File | null = null;

    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const formData = await req.formData().catch(() => null);
      if (!formData) {
        return NextResponse.json(
          {
            success: false,
            error: "Invalid form data",
            message: "Invalid form data",
          },
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
        return NextResponse.json(
          {
            success: false,
            error: "Invalid JSON body",
            message: "Invalid JSON body",
          },
          { status: 400 },
        );
      }
    }

    const update: Record<string, unknown> = {};

    // Moderation path, unchanged in behaviour: when `status` is sent it must be
    // one of the valid values, and `reason` becomes the rejection reason.
    // A body without `status` is now allowed — that's the profile-edit case.
    if (body.status !== undefined) {
      if (
        typeof body.status !== "string" ||
        !VALID_STATUSES.includes(body.status)
      ) {
        return NextResponse.json(
          {
            success: false,
            error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
            message: `status must be one of: ${VALID_STATUSES.join(", ")}`,
          },
          { status: 400 },
        );
      }
      update.status = body.status;
      if (body.reason) update.rejectionReason = body.reason;
    }

    for (const [key, value] of Object.entries(body)) {
      if (!ADMIN_EDITABLE_FIELDS.has(key) || value === undefined) continue;
      // Lowercase email so the unique index and case-sensitive lookups stay
      // consistent, matching the brand-side route.
      update[key] =
        typeof value === "string"
          ? key === "email"
            ? value.trim().toLowerCase()
            : value.trim()
          : value;
    }

    if (logoFile) {
      const uploaded = await uploadBrandLogo(id, logoFile);
      if (isLogoUploadError(uploaded)) {
        return NextResponse.json(
          {
            success: false,
            error: uploaded.message,
            message: uploaded.message,
          },
          { status: uploaded.status },
        );
      }
      update.logo = uploaded;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No valid fields provided",
          message: "No valid fields provided",
        },
        { status: 400 },
      );
    }

    await connectToDatabase();

    let brand;
    try {
      brand = await BrandModel.findByIdAndUpdate(
        id,
        { $set: update },
        { new: true, runValidators: true },
      ).select("-password -verificationToken");
    } catch (error: unknown) {
      // Duplicate key on the unique `email` index — surface as a clean 409
      // instead of the raw Mongo error.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: number }).code === 11000
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Email already in use",
            message: "Email already in use",
          },
          { status: 409 },
        );
      }
      throw error;
    }

    if (!brand) {
      return NextResponse.json(
        {
          success: false,
          error: "Brand not found",
          message: "Brand not found",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, brand }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json(
      { success: false, error: message, message },
      { status: 500 },
    );
  }
}
