import { randomInt } from "crypto";

// Promo-code inventory rules, shared by the brandhub deal routes and by
// campaign discountCodes.
//
// Supplied codes: trimmed, uppercased, deduped; each 4-32 chars of
// [A-Z0-9-_]; max 500 per request. Generated codes: PREFIX-XXXXXX (or bare
// XXXXXX without a prefix) over an unambiguous alphabet with no 0/O/1/I/L,
// via crypto.randomInt, unique within the deal.

export const MAX_CODES = 500;
const CODE_RE = /^[A-Z0-9\-_]{4,32}$/;
const PREFIX_RE = /^[A-Z0-9\-_]{1,10}$/;
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const RANDOM_LENGTH = 6;

type Ok = { codes: string[] };
type Err = { error: string };

/** Clean and validate brand-supplied codes. */
export function cleanSuppliedCodes(
  input: unknown,
  existing: string[] = [],
): Ok | Err {
  if (!Array.isArray(input) || input.some((c) => typeof c !== "string")) {
    return { error: "codes must be an array of strings" };
  }
  if (input.length > MAX_CODES) {
    return { error: `codes exceeds the maximum of ${MAX_CODES} per request` };
  }

  const rejected: string[] = [];
  const seen = new Set(existing);
  const cleaned: string[] = [];
  for (const raw of input as string[]) {
    const code = raw.trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      rejected.push(raw);
      continue;
    }
    if (seen.has(code)) continue; // dedupe silently
    seen.add(code);
    cleaned.push(code);
  }

  if (rejected.length > 0) {
    return {
      error:
        "Invalid codes (must be 4-32 chars, A-Z 0-9 - _ only): " +
        rejected.join(", "),
    };
  }
  if (cleaned.length === 0) {
    return { error: "No valid new codes remained after cleaning" };
  }
  if (existing.length + cleaned.length > MAX_CODES) {
    return { error: `A deal cannot hold more than ${MAX_CODES} codes` };
  }
  return { codes: cleaned };
}

/** Generate `count` unique codes, optionally prefixed. */
export function generateDealCodes(
  spec: unknown,
  existing: string[] = [],
): Ok | Err {
  if (typeof spec !== "object" || spec === null) {
    return { error: "generateCodes must be an object { count, prefix? }" };
  }
  const { count, prefix } = spec as { count?: unknown; prefix?: unknown };

  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    return { error: "generateCodes.count must be a positive integer" };
  }
  if (count > MAX_CODES) {
    return { error: `generateCodes.count is capped at ${MAX_CODES}` };
  }

  let cleanPrefix = "";
  if (prefix !== undefined) {
    if (typeof prefix !== "string" || !PREFIX_RE.test(prefix.trim().toUpperCase())) {
      return {
        error: "generateCodes.prefix must be 1-10 chars, A-Z 0-9 - _ only",
      };
    }
    cleanPrefix = prefix.trim().toUpperCase();
  }

  if (existing.length + count > MAX_CODES) {
    return { error: `A deal cannot hold more than ${MAX_CODES} codes` };
  }

  const seen = new Set(existing);
  const codes: string[] = [];
  while (codes.length < count) {
    let random = "";
    for (let i = 0; i < RANDOM_LENGTH; i++) {
      random += ALPHABET[randomInt(ALPHABET.length)];
    }
    const code = cleanPrefix ? `${cleanPrefix}-${random}` : random;
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return { codes };
}
