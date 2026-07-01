import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import connectToDatabase from "@/lib/mongodb";
import { OrganizationModel, BrandUserModel } from "@/lib/models";
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
 * Body:    { orgName: string; email: string; password: string }
 * Creates a new Organization and its first BrandUser as orgRole "owner".
 * Returns: { token: string; orgId: string; userId: string }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as {
    orgName?: string;
    email?: string;
    password?: string;
  } | null;

  const { orgName, email, password } = body ?? {};

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

  return NextResponse.json(
    { token, orgId: org._id.toString(), userId: user._id.toString() },
    { status: 201 },
  );
}
