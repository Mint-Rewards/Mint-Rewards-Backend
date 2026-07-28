import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { serverEnv } from "@/lib/env";

/**
 * POST /api/admin/login
 * Body:    { email: string; password: string }
 * Returns: { token: string }
 *
 * This route does NOT use requireAdminAuth — it is the endpoint that
 * issues the token.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null) as {
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

  // All three validated at boot in lib/env.ts.
  const { adminEmail, adminPasswordHash, adminJwtSecret } = serverEnv;

  // Run bcrypt.compare regardless of whether the email matched so that
  // response timing stays constant and prevents email enumeration.
  const emailMatch = email === adminEmail;
  const passwordValid = await bcrypt.compare(password, adminPasswordHash);

  if (!emailMatch || !passwordValid) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const token = jwt.sign(
    { role: "admin", email: adminEmail },
    adminJwtSecret,
    { expiresIn: "8h" },
  );

  return NextResponse.json({ token });
}
