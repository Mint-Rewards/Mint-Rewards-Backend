import jwt from "jsonwebtoken";
import type { BrandJwtPayload } from "@/lib/modules";

const JWT_EXPIRES_IN = "8h";

// Deliberately a separate secret from JWT_SECRET (consumer User) and
// ADMIN_JWT_SECRET (global admin) — BrandJwtPayload has a different shape
// (orgId/orgRole/moduleAccess) and keeping the secret distinct means a
// token from one system can never be mistaken for a valid token in another.
export function signBrandToken(payload: BrandJwtPayload): string {
  const secret = process.env.BRANDHUB_JWT_SECRET;
  if (!secret) throw new Error("BRANDHUB_JWT_SECRET is not set");
  return jwt.sign(payload, secret, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyBrandToken(token: string): BrandJwtPayload {
  const secret = process.env.BRANDHUB_JWT_SECRET;
  if (!secret) throw new Error("BRANDHUB_JWT_SECRET is not set");
  return jwt.verify(token, secret) as BrandJwtPayload;
}

export function extractBearerToken(authHeader?: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}
