/**
 * Durable diagnostics for failed Google ID-token verification.
 *
 * `verifyIdToken` collapses every failure mode into one 401 + "Invalid token"
 * for the client, and the only trace of *why* was a console.error — which
 * Vercel discards after a day. Field reports therefore arrive long after the
 * evidence is gone. This writes the reason into the Log collection instead,
 * where it survives 90 days (see the TTL index on LogSchema).
 *
 * The token's claims are decoded WITHOUT verification, purely to describe the
 * failure. Nothing here may ever be used to authenticate a request.
 */

import { Log } from "@/lib/models";
import dbConnect from "@/lib/mongodb";

export type UnverifiedClaims = {
  aud?: string;
  iss?: string;
  email?: string;
  iat?: number;
  exp?: number;
};

export type FailureDiagnosis =
  | "AUDIENCE_MISMATCH"
  | "EXPIRED"
  | "MALFORMED"
  | "UNKNOWN";

/**
 * Decode the payload segment of a JWT without verifying its signature.
 * Returns null for anything that is not a well-formed JWT payload.
 */
export function decodeUnverifiedClaims(idToken: string): UnverifiedClaims | null {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;

    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json);

    return claims && typeof claims === "object" ? (claims as UnverifiedClaims) : null;
  } catch {
    return null;
  }
}

/**
 * Classify the failure from the claims we can see, falling back to the
 * library's message. The two cases that matter operationally are a token
 * minted for a different OAuth client (a config/version problem, which is
 * never intermittent) and a token that sat in a client-side cache past its
 * one-hour life (which is always intermittent).
 */
export function diagnoseFailure(
  claims: UnverifiedClaims | null,
  expectedAudiences: string[],
  nowSeconds: number,
): FailureDiagnosis {
  if (!claims) return "MALFORMED";

  if (claims.aud && !expectedAudiences.includes(claims.aud)) {
    return "AUDIENCE_MISMATCH";
  }

  if (typeof claims.exp === "number" && claims.exp < nowSeconds) {
    return "EXPIRED";
  }

  return "UNKNOWN";
}

/**
 * Best-effort platform attribution: the audience a native Google sign-in mints
 * against is the iOS client ID on iOS and the web client ID on Android.
 */
function platformFromAudience(
  audience: string | undefined,
  iosClientId: string,
  webClientId: string,
): string {
  if (audience === iosClientId) return "ios";
  if (audience === webClientId) return "android";
  return "unknown";
}

/**
 * Persist one verification failure. Never throws — a diagnostics write must
 * not be able to change the outcome of an auth request.
 */
export async function logGoogleVerificationFailure(params: {
  idToken: string;
  reason: string;
  iosClientId: string;
  webClientId: string;
}): Promise<void> {
  const { idToken, reason, iosClientId, webClientId } = params;

  try {
    const expectedAudiences = [iosClientId, webClientId];
    const claims = decodeUnverifiedClaims(idToken);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const diagnosis = diagnoseFailure(claims, expectedAudiences, nowSeconds);

    await dbConnect();

    await Log.create({
      event: "GOOGLE_AUTH_VERIFY_FAILED",
      level: "error",
      userEmail: claims?.email,
      deviceId: "server",
      deviceModel: "server",
      platform: platformFromAudience(claims?.aud, iosClientId, webClientId),
      appVersion: "unknown",
      buildNumber: "unknown",
      timestamp: new Date(),
      extra: {
        diagnosis,
        reason,
        audience: claims?.aud ?? null,
        expectedAudiences,
        issuer: claims?.iss ?? null,
        issuedAt: claims?.iat ? new Date(claims.iat * 1000).toISOString() : null,
        expiresAt: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
        // How stale the token was when it arrived. A client that re-sends a
        // cached credential shows up here as hundreds or thousands of seconds.
        tokenAgeSeconds: claims?.iat ? nowSeconds - claims.iat : null,
        expiredForSeconds:
          claims?.exp && claims.exp < nowSeconds ? nowSeconds - claims.exp : null,
      },
    });
  } catch (error) {
    console.error(
      "[auth:google] failed to persist verification diagnostics:",
      error instanceof Error ? error.message : error,
    );
  }
}
