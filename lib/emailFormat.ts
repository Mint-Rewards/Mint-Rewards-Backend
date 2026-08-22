/**
 * Shared email format check.
 *
 * Extracted verbatim from app/api/users/signup/route.ts, which was the only
 * validator in the codebase and is now the second caller rather than the
 * owner. The referral endpoint needs the same rule, and a second regex written
 * beside this one would drift: signup would accept an address the referral
 * fan-out rejects, or worse, the reverse.
 *
 * The regex shape is load-bearing and must not be "simplified" back to
 * /^[^\s@]+@[^\s@]+\.[^\s@]+$/ — see the comment carried down from signup.
 */

/** RFC 5321 caps a forward path at 254 characters. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Label classes exclude '.', so each dot boundary has exactly one possible
 * split and the match is linear. The previous /^[^\s@]+@[^\s@]+\.[^\s@]+$/
 * let '.' match inside the domain classes too, making the split ambiguous
 * and backtracking polynomial on non-matching input (CodeQL js/polynomial-redos).
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Length is checked before the regex so an oversized string is rejected
 * outright rather than matched against.
 */
export function isValidEmail(value: string): boolean {
  if (value.length > MAX_EMAIL_LENGTH) return false;
  return EMAIL_REGEX.test(value);
}

export default isValidEmail;
