import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { serverEnv } from "@/lib/env";

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

  try {
    // ADMIN_JWT_SECRET is validated at boot in lib/env.ts.
    const payload = jwt.verify(token, serverEnv.adminJwtSecret) as AdminPayload;

    if (payload.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return { admin: payload };
  } catch {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }
}
