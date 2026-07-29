import crypto from "crypto";
import { serverEnv } from "@/lib/env";

// Peppered so a leaked passwordReset/emailVerification subdocument (backup,
// replica, injection) can't be brute-forced offline — a bare SHA-256 of a
// 6-digit code only has 1M possibilities and reverses instantly.
//
// OTP_PEPPER is now required (lib/env.ts). It previously fell through to the
// JWT secrets and finally to "" — an empty HMAC key, which silently defeated
// the peppering this module exists to provide.
const OTP_PEPPER = serverEnv.otpPepper;

export function generateOtp(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashOtp(otp: string): string {
  return crypto.createHmac("sha256", OTP_PEPPER).update(otp).digest("hex");
}

export function verifyOtp(submittedOtp: string, storedHash: string): boolean {
  const submittedHash = Buffer.from(hashOtp(submittedOtp), "hex");
  const knownHash = Buffer.from(storedHash, "hex");
  return (
    submittedHash.length === knownHash.length &&
    crypto.timingSafeEqual(submittedHash, knownHash)
  );
}
