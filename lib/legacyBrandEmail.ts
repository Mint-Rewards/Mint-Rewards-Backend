/**
 * Legacy brand pairing.
 *
 * Brands exist twice in the data: an original legacy document, and the BrandHub
 * document cloned from it by scripts/clone-legacy-brands.js. The two carry
 * different `_id`s, and a campaign may reference either one.
 *
 * The pairing used to be encoded in the clone's `email`, as
 * `legacy-<24hex>@example.com`. That overloaded contact data as an identity
 * key: a brand manager correcting their email in BrandHub Settings silently
 * broke every campaign that resolved through the pairing (issue #98). The
 * pairing now lives in its own indexed field, `Brand.legacyBrandId`.
 *
 * The email form is still recognised here so the migration can backfill from
 * it, and so clones written before the field existed keep resolving. Nothing
 * outside this module should parse a brand email.
 */

/** Matches the synthesized email a cloned legacy brand was given. */
export const LEGACY_EMAIL_RE = /^legacy-([0-9a-f]{24})@example\.com$/i;

/** The email a clone of `sourceId` was given. Kept for the migration only. */
export function legacyEmailFor(sourceId: unknown): string {
  return `legacy-${String(sourceId)}@example.com`;
}

/**
 * The legacy `_id` a brand document is paired with, or null if it is not a
 * clone. Prefers the indexed `legacyBrandId`, falling back to the email form
 * for clones that predate the field.
 */
export function legacyBrandIdOf(brand: {
  legacyBrandId?: unknown;
  email?: unknown;
}): string | null {
  if (brand.legacyBrandId) return String(brand.legacyBrandId);

  const match = LEGACY_EMAIL_RE.exec(String(brand.email ?? ""));
  return match ? match[1] : null;
}
