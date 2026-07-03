import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import connectToDatabase from "@/lib/mongodb";
import { Types } from "mongoose";
import { OrganizationModel, BrandUserModel, BrandModel } from "@/lib/models";
import { signBrandToken } from "@/lib/brandJwt";

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

/**
 * POST /api/brandhub/auth/register
 * Body:    { orgName: string; email: string; password: string; brandName?: string }
 * Creates a new Organization and its first BrandUser as orgRole "owner".
 * If brandName is provided, also creates the org's first Brand.
 * Returns: { token, orgId, userId, brands, defaultBrandId } — same shape as
 * login whether or not a brand was created, so the frontend handles one contract.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as {
    orgName?: string;
    email?: string;
    password?: string;
    brandName?: string;
  } | null;

  const { orgName, email, password, brandName } = body ?? {};

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

  await connectToDatabase();

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await BrandUserModel.findOne({
    email: normalizedEmail,
  }).lean();

  if (existing) {
    return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  }

  const org = await OrganizationModel.create({ name: orgName });
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
    },
    { status: 201 },
  );
}
