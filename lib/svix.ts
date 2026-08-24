import crypto from "crypto";

/**
 * Svix webhook signature verification, which is the scheme Resend uses.
 *
 * Implemented here rather than pulling in the `svix` package: it is one HMAC
 * and a timestamp check, and a webhook that accepts unsigned input is the
 * thing being prevented — a dependency is a poor place to put that.
 *
 * The signed payload is `${id}.${timestamp}.${body}`, and the secret is
 * base64 after its "whsec_" prefix. The svix-signature header carries a
 * space-separated list of `v1,<base64>` entries, because a secret rotation
 * publishes both the old and new signature for a window.
 */
const TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function verifySvixSignature(
  body: string,
  headers: SvixHeaders,
  secret: string,
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret) return false;

  // Replay window. Without it a captured delivery stays valid forever, and a
  // replayed "bounce" event is enough to suppress an arbitrary address.
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  if (Math.abs(Date.now() / 1000 - sent) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  const expectedBuf = Buffer.from(expected);

  // Any one of the offered versions matching is a pass, and every candidate is
  // compared in constant time.
  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const providedBuf = Buffer.from(value);
    if (providedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  });
}
