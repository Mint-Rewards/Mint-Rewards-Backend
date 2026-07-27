import crypto from "crypto";

// Peppered so a leaked passwordReset/emailVerification subdocument (backup,
// replica, injection) can't be brute-forced offline — a bare SHA-256 of a
// 6-digit code only has 1M possibilities and reverses instantly.
const OTP_PEPPER =
  process.env.OTP_PEPPER ||
  process.env.JWT_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.NEXT_JWT_SECRET ||
  "";

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
