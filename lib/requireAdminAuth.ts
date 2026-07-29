import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";

export interface AdminPayload {
  email: string;
  role: string;
}

type AuthOk = { admin: AdminPayload };

/**
 * Call at the top of any route handler that requires admin credentials.
 * Returns the decoded payload on success, or a ready-to-return NextResponse
 * with the appropriate 401/403/500 status on failure.
 *
 * Usage:
 *   const auth = requireAdminAuth(req);
 *   if (auth instanceof NextResponse) return auth;
 *   // auth.admin is now available
 */
export function requireAdminAuth(req: NextRequest): AuthOk | NextResponse {
  const authHeader = req.headers.get("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "No token provided" }, { status: 401 });
  }

  const token = authHeader.split(" ")[1];
  const secret = process.env.ADMIN_JWT_SECRET;

  if (!secret) {
    console.error("[requireAdminAuth] ADMIN_JWT_SECRET is not set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  try {
    const payload = jwt.verify(token, secret) as AdminPayload;

    if (payload.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return { admin: payload };
  } catch {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }
}
