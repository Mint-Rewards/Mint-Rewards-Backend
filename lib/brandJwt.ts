import jwt from "jsonwebtoken";
import type { BrandJwtPayload } from "@/lib/modules";
import { serverEnv } from "@/lib/env";

const JWT_EXPIRES_IN = "8h";

// Deliberately a separate secret from JWT_SECRET (consumer User) and
// ADMIN_JWT_SECRET (global admin) — BrandJwtPayload has a different shape
// (orgId/orgRole/moduleAccess) and keeping the secret distinct means a
// token from one system can never be mistaken for a valid token in another.
export function signBrandToken(payload: BrandJwtPayload): string {
  return jwt.sign(payload, serverEnv.brandhubJwtSecret, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

export function verifyBrandToken(token: string): BrandJwtPayload {
  return jwt.verify(token, serverEnv.brandhubJwtSecret) as BrandJwtPayload;
}

export function extractBearerToken(
  authHeader?: string | null,
): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}
