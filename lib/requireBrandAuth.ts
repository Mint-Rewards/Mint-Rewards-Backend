import { NextRequest, NextResponse } from "next/server";
import { verifyBrandToken, extractBearerToken } from "@/lib/brandJwt";
import type { BrandJwtPayload } from "@/lib/modules";

type AuthOk = { brandUser: BrandJwtPayload };

/**
 * Call at the top of any BrandHub route handler that only needs a valid
 * BrandUser session, with no module-specific access check.
 *
 * Usage:
 *   const auth = requireBrandAuth(req);
 *   if (auth instanceof NextResponse) return auth;
 *   // auth.brandUser is now available
 */
export function requireBrandAuth(req: NextRequest): AuthOk | NextResponse {
  const token = extractBearerToken(req.headers.get("authorization"));

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const brandUser = verifyBrandToken(token);
    return { brandUser };
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
