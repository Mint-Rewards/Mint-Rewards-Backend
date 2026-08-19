export const MIN_PASSWORD_LENGTH = 8;

/**
 * bcrypt hashes only the first 72 bytes of its input and silently ignores the
 * rest, so any two passwords sharing a 72-byte prefix are interchangeable at
 * login. 64 characters sits comfortably under that even for multi-byte input,
 * which keeps the truncation unreachable rather than merely unlikely.
 */
export const MAX_PASSWORD_LENGTH = 64;

/**
 * Returns a client-facing error message, or null when the password is
 * acceptable. Callers validate at the request boundary, before hashing.
 */
export function validatePasswordLength(password: unknown): string | null {
  if (typeof password !== "string") {
    return "You must enter a password.";
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`;
  }

  return null;
}
