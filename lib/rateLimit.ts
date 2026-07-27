import crypto from "crypto";
import mongoose, { Schema, type Model } from "mongoose";
import connectToDatabase from "@/lib/mongodb";

interface RateLimitDocument extends mongoose.Document<string> {
  _id: string;
  count: number;
  expiresAt: Date;
}

const RateLimitSchema = new Schema<RateLimitDocument>(
  {
    _id: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RateLimitModel =
  (mongoose.models.RateLimit as Model<RateLimitDocument>) ||
  mongoose.model<RateLimitDocument>("RateLimit", RateLimitSchema, "rateLimits");

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

// Emails are hashed in rate-limit keys so raw identifiers are never stored.
export function hashKey(value: string): string {
  return crypto
    .createHash("sha256")
    .update(value.toLowerCase().trim())
    .digest("hex")
    .slice(0, 32);
}

export interface RateLimitResult {
  limited: boolean;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  scope: string,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  try {
    await connectToDatabase();
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const doc = await RateLimitModel.findOneAndUpdate(
      { _id: `${scope}:${key}:${windowStart}` },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date(windowStart + windowMs) },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (doc && doc.count > limit) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((windowStart + windowMs - Date.now()) / 1000),
        ),
      };
    }
    return { limited: false, retryAfterSeconds: 0 };
  } catch (error) {
    // Fail open: rate limiting is defense-in-depth; OTP attempt caps and
    // token gating remain the hard floor if Mongo is briefly unavailable.
    console.error("Rate limit check failed:", error);
    return { limited: false, retryAfterSeconds: 0 };
  }
}

export function rateLimitResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "Too many requests. Please try again later." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
