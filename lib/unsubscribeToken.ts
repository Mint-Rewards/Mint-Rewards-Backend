import crypto from "crypto";
import { serverEnv } from "@/lib/env";
import { normalizeAddress } from "@/lib/emailSuppression";

/**
 * Signed unsubscribe tokens.
 *
 * The link has to work with no session — the recipient of a referral
 * invitation has no account, which is the whole reason they want out — so the
 * address travels in the URL and the signature is what stops it being a
 * one-parameter unsubscribe-anyone endpoint.
 *
 * Keyed off JWT_SECRET rather than a new required variable, with a domain
 * separation label mixed in so an unsubscribe token can never be presented as
 * a session token or vice versa. Adding a required env var would have taken
 * every deployment down at boot until it was set, for no security gain over
 * separating the domains of a secret that is already validated at boot.
 *
 * No expiry. An unsubscribe link in a two-year-old email must still work;
 * that is the entire promise being made, and the token authorises nothing
 * beyond "stop emailing this one address".
 */
const LABEL = "email-unsubscribe:v1";

function sign(address: string): string {
  return crypto
    .createHmac("sha256", serverEnv.jwtSecret)
    .update(`${LABEL}:${address}`)
    .digest("base64url");
}

export function unsubscribeToken(address: string): string {
  return sign(normalizeAddress(address));
}

/**
 * Constant-time comparison. A leaky compare here would let an attacker forge a
 * token for an arbitrary address one byte at a time, and unsubscribing a
 * stranger from their own password-reset mail is a real denial of service.
 */
export function verifyUnsubscribeToken(
  address: string,
  token: string,
): boolean {
  if (!token) return false;

  const expected = Buffer.from(sign(normalizeAddress(address)));
  const provided = Buffer.from(token);

  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

/** Absolute URL for the unsubscribe link embedded in outreach templates. */
export function unsubscribeUrl(address: string, baseUrl: string): string {
  const normalized = normalizeAddress(address);
  const url = new URL("/api/email/unsubscribe", baseUrl);
  url.searchParams.set("email", normalized);
  url.searchParams.set("token", unsubscribeToken(normalized));
  return url.toString();
}
