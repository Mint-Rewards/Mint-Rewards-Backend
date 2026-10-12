/**
 * Turning what somebody typed into a number we can treat as an identity.
 *
 * Only Pakistani mobiles, deliberately. This exists to let a household sign up
 * and be collected from, every household is in Pakistan, and accepting a
 * number we cannot deliver an OTP to would create an account nobody can ever
 * sign in to. Widening it later is a decision with a cost; starting wide is a
 * decision with no owner.
 *
 * See docs/specs/phone-and-whatsapp-signup.md.
 */

/**
 * The country's mobile prefixes, as the PTA allocates them.
 *
 * Mobile only — a landline cannot receive a WhatsApp message, and letting one
 * through produces an account that can never be verified. Pakistani mobile
 * numbers are `3xx` followed by seven digits, which is the whole of the rule
 * worth encoding: the operator-level allocations inside `3xx` change as
 * licences move, and a list of them here would start rotting immediately.
 */
const PK_MOBILE = /^3\d{9}$/;

/** What `normalizePhone` could not make sense of. */
export type PhoneProblem =
  | "EMPTY"
  | "NOT_A_NUMBER"
  | "NOT_PAKISTANI"
  | "NOT_MOBILE";

export const PHONE_PROBLEM_TEXT: Record<PhoneProblem, string> = {
  EMPTY: "Enter your mobile number.",
  NOT_A_NUMBER: "That does not look like a phone number.",
  NOT_PAKISTANI: "Enter a Pakistani mobile number, starting 03 or +92 3.",
  NOT_MOBILE: "That is not a mobile number — an OTP cannot reach it.",
};

export type PhoneResult =
  | { ok: true; e164: string; national: string }
  | { ok: false; problem: PhoneProblem };

/**
 * `+923001234567` from any of the ways people write it.
 *
 * Accepts `03001234567`, `3001234567`, `+92 300 1234567`, `0092-300-1234567`
 * and the same with spaces, dashes or brackets — because a person reading
 * their number off a SIM packet types what they see, and refusing them over
 * punctuation loses a household for no reason.
 *
 * Strict about the thing that matters: what comes out is one canonical form,
 * because it is compared against stored identities and two spellings of one
 * number would be two accounts.
 */
export function normalizePhone(input: string | null | undefined): PhoneResult {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, problem: "EMPTY" };

  // Everything that is not a digit goes, except a leading + which carries
  // meaning. A number with letters in it was never a number.
  if (/[A-Za-z]/.test(raw)) return { ok: false, problem: "NOT_A_NUMBER" };
  const plus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return { ok: false, problem: "NOT_A_NUMBER" };

  let national: string;
  if (digits.startsWith("0092")) {
    national = digits.slice(4);
  } else if (digits.startsWith("92") && (plus || digits.length > 11)) {
    /*
     * `92...` is only a country code when it cannot be a local number.
     *
     * `923001234` is nine digits and is nobody's Pakistani mobile, but
     * `03001234567` stripped of its zero is `3001234567` — and a naive
     * "starts with 92" rule would mangle any local number that happened to
     * begin 92. Requiring either an explicit + or a length that only a
     * country-coded number can have keeps both readings honest.
     */
    national = digits.slice(2);
  } else if (digits.startsWith("0")) {
    national = digits.slice(1);
  } else {
    national = digits;
  }

  if (!/^\d+$/.test(national)) return { ok: false, problem: "NOT_A_NUMBER" };

  /*
   * A number that is the right length but the wrong country.
   *
   * Told apart from "not a mobile" because the two call for different moves:
   * one means use a different number, the other means check what you typed.
   */
  if (national.length !== 10) {
    return {
      ok: false,
      problem: national.length > 10 || plus ? "NOT_PAKISTANI" : "NOT_A_NUMBER",
    };
  }
  if (!PK_MOBILE.test(national)) return { ok: false, problem: "NOT_MOBILE" };

  return { ok: true, e164: `+92${national}`, national: `0${national}` };
}

/** True when this is a number we could send an OTP to. */
export function isValidPhone(input: string | null | undefined): boolean {
  return normalizePhone(input).ok;
}

/**
 * The number as a person would read it back: `0300 1234567`.
 *
 * For anything shown to a household — a confirmation screen, a support
 * record. E.164 is for storage and comparison, not for reading aloud.
 */
export function displayPhone(e164: string): string {
  const parsed = normalizePhone(e164);
  if (!parsed.ok) return e164;
  return `${parsed.national.slice(0, 4)} ${parsed.national.slice(4)}`;
}
