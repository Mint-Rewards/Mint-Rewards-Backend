/**
 * The pieces both phone endpoints need, in one place so they cannot disagree.
 *
 * See docs/specs/phone-and-whatsapp-signup.md.
 */
import { hashOtp } from "@/lib/otp";

/** Ten minutes, matching the email OTP. */
export const PHONE_OTP_TTL_MS = 10 * 60 * 1000;

/**
 * How long before a code can be sent to the same number again.
 *
 * Separate from the rate limit and doing a different job: the limit stops
 * abuse, this stops an impatient person spending our money by tapping resend.
 * Every WhatsApp authentication message is billed.
 */
export const PHONE_RESEND_THROTTLE_MS = 60 * 1000;

/** The most wrong guesses before a code is dead. */
export const PHONE_MAX_ATTEMPTS = 5;

export const phoneOtpBlock = (code: string) => ({
  otpHash: hashOtp(code),
  expiresAt: new Date(Date.now() + PHONE_OTP_TTL_MS).toISOString(),
  attempts: 0,
  lastSentAt: new Date().toISOString(),
});

export interface StoredOtp {
  otpHash?: string;
  expiresAt?: string;
  attempts?: number;
  lastSentAt?: string;
}

/**
 * Why a stored code cannot be accepted, or null if it can.
 *
 * Returned rather than thrown so the caller decides what to disclose. The
 * distinctions matter to an honest person at a door — "that code has expired"
 * and "that code is wrong" call for different actions — and the caller is
 * what knows whether saying so is safe in its context.
 */
export function otpProblem(
  otp: StoredOtp | null,
  now = Date.now(),
): "NONE_SENT" | "EXPIRED" | "TOO_MANY_ATTEMPTS" | null {
  if (!otp?.otpHash) return "NONE_SENT";
  if (!otp.expiresAt || new Date(otp.expiresAt).getTime() < now) return "EXPIRED";
  if ((otp.attempts ?? 0) >= PHONE_MAX_ATTEMPTS) return "TOO_MANY_ATTEMPTS";
  return null;
}

/** True when a resend would be too soon. */
export function resentTooSoon(otp: StoredOtp | null, now = Date.now()): boolean {
  if (!otp?.lastSentAt) return false;
  return now - new Date(otp.lastSentAt).getTime() < PHONE_RESEND_THROTTLE_MS;
}
