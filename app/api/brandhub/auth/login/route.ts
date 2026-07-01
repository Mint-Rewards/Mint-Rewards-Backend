import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import connectToDatabase from "@/lib/mongodb";
import { BrandUserModel } from "@/lib/models";
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
 * POST /api/brandhub/auth/login
 * Body:    { email: string; password: string }
 * Returns: { token: string }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as {
    email?: string;
    password?: string;
  } | null;

  const { email, password } = body ?? {};

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 },
    );
  }

  await connectToDatabase();

  const normalizedEmail = email.toLowerCase().trim();
  const user = await BrandUserModel.findOne({ email: normalizedEmail });

  // Run bcrypt.compare regardless of whether a user was found so that
  // response timing stays constant and prevents email enumeration.
  const dummyHash =
    "$2b$10$invalidhashfortimingnormalization000000000000000000000";
  const passwordValid = await bcrypt.compare(
    password,
    user?.passwordHash ?? dummyHash,
  );

  if (!user || !passwordValid) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const token = signBrandToken({
    sub: user._id.toString(),
    orgId: user.orgId.toString(),
    orgRole: user.orgRole,
    moduleAccess: user.moduleAccess,
  });

  return NextResponse.json({ token });
}
