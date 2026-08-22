import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { put } from "@vercel/blob";
import connectToDatabase from "@/lib/mongodb";
import mongoose, { Types } from "mongoose";
import { OrganizationModel, BrandUserModel, BrandModel } from "@/lib/models";
import { signBrandToken } from "@/lib/brandJwt";
import { MODULE_CATALOGUE, hasActiveSubscription } from "@/lib/modules";
import { validatePasswordLength } from "@/lib/password";

const MAX_LOGO_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/brandhub/auth/register
 * Body:    { orgName: string; email: string; password: string; brandName?: string; contactName?: string; phone?: string; webLink?: string; website?: string; appLink?: string; address?: string; description?: string }
 *          as JSON, or multipart/form-data with the same fields plus an
 *          optional "logo" image file (stored on the org's first Brand and
 *          returned as a public URL in brands[].logo). category, contactName,
 *          phone, and webLink all fall back to placeholders when omitted —
 *          the Brand schema requires a value for each (see comments at the
 *          create() call below). webLink also accepts "website" (the
 *          frontend sends both keys for the same value). appLink/address/
 *          description default to "" when omitted (not schema-required).
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
  let category: string | undefined;
  let contactName: string | undefined;
  let phone: string | undefined;
  let webLink: string | undefined;
  let appLink: string | undefined;
  let address: string | undefined;
  let description: string | undefined;
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
      category = str("category");
      contactName = str("contactName");
      phone = str("phone");
      webLink = str("webLink") ?? str("website");
      appLink = str("appLink");
      address = str("address");
      description = str("description");
      const logo = formData.get("logo");
      if (logo instanceof File && logo.size > 0) logoFile = logo;
    }
  } else {
    const body = (await req.json().catch(() => null)) as {
      orgName?: string;
      email?: string;
      password?: string;
      brandName?: string;
      category?: string;
      contactName?: string;
      phone?: string;
      webLink?: string;
      website?: string;
      appLink?: string;
      address?: string;
      description?: string;
    } | null;
    ({ orgName, email, password, brandName, category, contactName } = body ?? {});
    contactName = contactName?.trim() || undefined;
    phone = body?.phone?.trim() || undefined;
    webLink = (body?.webLink?.trim() || body?.website?.trim()) || undefined;
    appLink = body?.appLink?.trim() || undefined;
    address = body?.address?.trim() || undefined;
    description = body?.description?.trim() || undefined;
  }

  if (!orgName || !email || !password) {
    return NextResponse.json(
      { error: "orgName, email, and password are required" },
      { status: 400 },
    );
  }

  const passwordError = validatePasswordLength(password);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
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

  const passwordHash = await bcrypt.hash(password, 10);

  const brands: {
    id: string;
    brandName: string;
    companyName: string;
    logo: string | null;
  }[] = [];

  // All three documents are created inside one transaction. Previously the
  // Organization and BrandUser were committed before BrandModel.create ran, so
  // a duplicate brand email returned 409 while leaving a real org and login
  // behind — and retrying then failed earlier, on the BrandUser check above,
  // with "Email already in use". The user was stranded with an account holding
  // zero brands after a UI that told them signup had failed (issue #99).
  //
  // Requires a replica set. Both deployed and CI use Atlas (mongodb+srv), and
  // README.md documents the local requirement.
  const session = await mongoose.startSession();
  let org: Awaited<ReturnType<typeof OrganizationModel.create>>[number];
  let user: Awaited<ReturnType<typeof BrandUserModel.create>>[number];

  try {
    await session.withTransaction(async () => {
      // Reset on retry: withTransaction may run this callback more than once.
      brands.length = 0;

      // New orgs start with an active subscription to every catalogue module
      // so all tabs are usable immediately; a billing flow can narrow this
      // later.
      [org] = await OrganizationModel.create(
        [
          {
            name: orgName,
            moduleSubscriptions: MODULE_CATALOGUE.map((m) => ({
              module: m.id,
              status: "active",
              activatedAt: new Date(),
              expiresAt: null,
            })),
          },
        ],
        { session },
      );

      [user] = await BrandUserModel.create(
        [
          {
            orgId: org._id,
            email: normalizedEmail,
            passwordHash,
            orgRole: "owner",
            moduleAccess: [],
          },
        ],
        { session },
      );

      if (brandName) {
        // `email` is intentionally the org owner's own login email here (not a
        // synthesized placeholder) — Brand.email has a unique index, so this
        // can collide if a Brand elsewhere already used this address.
        // category/webLink/contactName/phone are all schema-required — fall
        // back to a placeholder for each when omitted so a missing optional
        // field never throws an uncaught Mongoose ValidationError.
        const brandId = new Types.ObjectId();
        const [brand] = await BrandModel.create(
          [
            {
              _id: brandId,
              orgId: org._id,
              brandName,
              companyName: orgName,
              email: normalizedEmail,
              category: category ?? "general",
              webLink: webLink ?? "https://example.com",
              appLink: appLink ?? "",
              address: address ?? "",
              description: description ?? "",
              contactName: contactName ?? normalizedEmail,
              phone: phone ?? "N/A",
              registrationNumber: `BH-${brandId.toString()}`,
              ...(logoUrl ? { logo: logoUrl } : {}),
            },
          ],
          { session },
        );

        brands.push({
          id: brand._id.toString(),
          brandName: brand.brandName,
          companyName: brand.companyName,
          logo: brand.logo ?? null,
        });
      }
    });
  } catch (error: unknown) {
    // Duplicate key. The pre-check above is a TOCTOU read, not a constraint,
    // so a concurrent signup can still collide on BrandUser.email; Brand.email
    // can collide with a brand registered elsewhere. Either way the
    // transaction has rolled back and nothing was written.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    ) {
      const keyPattern = (error as { keyPattern?: Record<string, unknown> })
        .keyPattern;
      const message =
        keyPattern && "registrationNumber" in keyPattern
          ? "Could not allocate a unique brand record. Please retry."
          : "This email is already registered.";
      return NextResponse.json({ error: message }, { status: 409 });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  const token = signBrandToken({
    sub: user!._id.toString(),
    orgId: org!._id.toString(),
    orgRole: "owner",
    moduleAccess: [],
  });

  return NextResponse.json(
    {
      token,
      orgId: org!._id.toString(),
      userId: user!._id.toString(),
      brands,
      defaultBrandId: brands[0]?.id ?? null,
      // Same contract as login. New orgs subscribe to the full catalogue at
      // creation, so this lists every module.
      subscribedModules: MODULE_CATALOGUE.filter((m) =>
        hasActiveSubscription(org!.moduleSubscriptions ?? [], m.id),
      ).map((m) => m.id),
    },
    { status: 201 },
  );
}
