import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { put } from "@vercel/blob";
import connectToDatabase from "@/lib/mongodb";
import { Types } from "mongoose";
import { OrganizationModel, BrandUserModel, BrandModel } from "@/lib/models";
import { signBrandToken } from "@/lib/brandJwt";
import { MODULE_CATALOGUE, hasActiveSubscription } from "@/lib/modules";

const MAX_LOGO_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/brandhub/auth/register
 * Body:    { orgName: string; email: string; password: string; brandName?: string }
 *          as JSON, or multipart/form-data with the same fields plus an
 *          optional "logo" image file (stored on the org's first Brand and
 *          returned as a public URL in brands[].logo).
 * Creates a new Organization and its first BrandUser as orgRole "owner".
 * If brandName is provided, also creates the org's first Brand.
 * Returns: { token, orgId, userId, brands, defaultBrandId } — same shape as
 * login whether or not a brand was created, so the frontend handles one contract.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let orgName: string | undefined;
  let email: string | undefined;
  let password: string | undefined;
  let brandName: string | undefined;
  let logoFile: File | null = null;

  if (req.headers.get("content-type")?.includes("multipart/form-data")) {
    const formData = await req.formData().catch(() => null);
    if (formData) {
      const str = (key: string) => {
        const v = formData.get(key);
        return typeof v === "string" && v.trim() ? v.trim() : undefined;
      };
      orgName = str("orgName");
      email = str("email");
      password = str("password");
      brandName = str("brandName");
      const logo = formData.get("logo");
      if (logo instanceof File && logo.size > 0) logoFile = logo;
    }
  } else {
    const body = (await req.json().catch(() => null)) as {
      orgName?: string;
      email?: string;
      password?: string;
      brandName?: string;
    } | null;
    ({ orgName, email, password, brandName } = body ?? {});
  }

  if (!orgName || !email || !password) {
    return NextResponse.json(
      { error: "orgName, email, and password are required" },
      { status: 400 },
    );
  }

  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 },
    );
  }

  // Validate and upload the logo before creating any documents, so a bad
  // file can't leave a half-registered org behind.
  let logoUrl: string | null = null;
  if (logoFile) {
    if (!logoFile.type.startsWith("image/")) {
      return NextResponse.json(
        { error: "Logo must be an image file" },
        { status: 400 },
      );
    }
    if (logoFile.size > MAX_LOGO_SIZE_BYTES) {
      return NextResponse.json(
        { error: "Logo must be 5MB or smaller" },
        { status: 400 },
      );
    }

    const extension = logoFile.name.includes(".")
      ? `.${logoFile.name.split(".").pop()?.toLowerCase()}`
      : "";
    const uniqueName = `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}${extension || ".png"}`;
    const blob = await put(
      `brands/${uniqueName}`,
      Buffer.from(await logoFile.arrayBuffer()),
      {
        access: "public",
        contentType: logoFile.type || "application/octet-stream",
        token: process.env.BLOB_PUBLIC_READ_WRITE_TOKEN,
      },
    );
    logoUrl = blob.url;
  }

  await connectToDatabase();

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await BrandUserModel.findOne({
    email: normalizedEmail,
  }).lean();

  if (existing) {
    return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  }

  // New orgs start with an active subscription to every catalogue module so
  // all tabs are usable immediately; a billing flow can narrow this later.
  const org = await OrganizationModel.create({
    name: orgName,
    moduleSubscriptions: MODULE_CATALOGUE.map((m) => ({
      module: m.id,
      status: "active",
      activatedAt: new Date(),
      expiresAt: null,
    })),
  });
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await BrandUserModel.create({
    orgId: org._id,
    email: normalizedEmail,
    passwordHash,
    orgRole: "owner",
    moduleAccess: [],
  });

  const token = signBrandToken({
    sub: user._id.toString(),
    orgId: org._id.toString(),
    orgRole: "owner",
    moduleAccess: [],
  });

  const brands: {
    id: string;
    brandName: string;
    companyName: string;
    logo: string | null;
  }[] = [];

  if (brandName) {
    // The legacy Brand schema requires several fields (with unique indexes
    // on email and registrationNumber) that don't exist at registration
    // time — fill them with unique placeholders keyed to the brand id.
    const brandId = new Types.ObjectId();
    const brand = await BrandModel.create({
      _id: brandId,
      orgId: org._id,
      brandName,
      companyName: orgName,
      email: `brand-${brandId.toString()}@brandhub.local`,
      category: "general",
      webLink: "https://example.com",
      contactName: normalizedEmail,
      phone: "N/A",
      registrationNumber: `BH-${brandId.toString()}`,
      ...(logoUrl ? { logo: logoUrl } : {}),
    });
    brands.push({
      id: brand._id.toString(),
      brandName: brand.brandName,
      companyName: brand.companyName,
      logo: brand.logo ?? null,
    });
  }

  return NextResponse.json(
    {
      token,
      orgId: org._id.toString(),
      userId: user._id.toString(),
      brands,
      defaultBrandId: brands[0]?.id ?? null,
      // Same contract as login. New orgs subscribe to the full catalogue at
      // creation, so this lists every module.
      subscribedModules: MODULE_CATALOGUE.filter((m) =>
        hasActiveSubscription(org.moduleSubscriptions ?? [], m.id),
      ).map((m) => m.id),
    },
    { status: 201 },
  );
}
