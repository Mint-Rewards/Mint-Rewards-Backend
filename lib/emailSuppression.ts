import mongoose, { Schema, type Model } from "mongoose";
import connectToDatabase from "@/lib/mongodb";

/**
 * Addresses that must not be emailed, and why.
 *
 * Referral mail goes to people who never opted in, and the template footer
 * promises we will not email them again unless they sign up. Nothing enforced
 * that promise except the referral dedupe — a side effect of a different
 * feature, which is not a mechanism (issue #145). This is the mechanism.
 *
 * The address is the _id: it is naturally unique, the lookup is a primary-key
 * hit, and an upsert is idempotent without any extra index. Stored lowercased
 * and trimmed, matching how every write path in the codebase normalises.
 *
 * Not hashed, unlike rate-limit keys. A suppression list has to be readable by
 * an operator answering "why did this person not get their password reset",
 * and a hashed list cannot answer that. It is also the record that
 * demonstrates an opt-out was honoured, which an opaque digest does not.
 */
export type SuppressionReason =
  "bounce" | "complaint" | "unsubscribe" | "manual";

export interface EmailSuppressionDocument extends mongoose.Document<string> {
  _id: string;
  reason: SuppressionReason;
  /** Free-form provenance: "resend-webhook", "unsubscribe-link", an operator. */
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

const EmailSuppressionSchema = new Schema<EmailSuppressionDocument>(
  {
    _id: { type: String, required: true },
    reason: {
      type: String,
      required: true,
      enum: ["bounce", "complaint", "unsubscribe", "manual"],
    },
    source: { type: String, required: true },
  },
  { versionKey: false, timestamps: true },
);

const EmailSuppressionModel =
  (mongoose.models.EmailSuppression as Model<EmailSuppressionDocument>) ||
  mongoose.model<EmailSuppressionDocument>(
    "EmailSuppression",
    EmailSuppressionSchema,
    "emailSuppressions",
  );

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Mail falls into two classes, and they suppress differently.
 *
 * "transactional" is mail the recipient's own action asked for: signup
 * confirmation codes, password resets. A deliverability failure (bounce,
 * spam complaint) must stop these too — continuing to send to an address that
 * hard-bounces is what damages the sending domain, and that domain is shared
 * with the auth mail the signup flow depends on.
 *
 * "outreach" is mail nobody asked for: the referral invitation. Everything
 * that stops transactional mail stops this, plus an explicit unsubscribe.
 *
 * The asymmetry is the point. Somebody who unsubscribes from referral
 * invitations and later signs up must still receive their password reset —
 * honouring an opt-out by locking them out of their own account would be a
 * worse outcome than the one being prevented.
 */
export type MailCategory = "transactional" | "outreach";

const BLOCKS_TRANSACTIONAL: ReadonlySet<SuppressionReason> = new Set([
  "bounce",
  "complaint",
  "manual",
]);

export async function isSuppressed(
  address: string,
  category: MailCategory,
): Promise<boolean> {
  try {
    await connectToDatabase();
    const record = await EmailSuppressionModel.findById(
      normalizeAddress(address),
    ).select("reason");

    if (!record) return false;
    if (category === "outreach") return true;
    return BLOCKS_TRANSACTIONAL.has(record.reason);
  } catch (error) {
    // Fail OPEN, deliberately, and only for transactional mail. A Mongo blip
    // must not stop a password reset. Outreach fails CLOSED instead: the cost
    // of not sending an invitation is nothing, and the cost of mailing a
    // suppressed address is a complaint against the auth sending domain.
    console.error("Suppression check failed:", error);
    return category === "outreach";
  }
}

/**
 * Records a suppression. Idempotent, and later reasons overwrite earlier ones
 * so an unsubscribe that is followed by a hard bounce ends up recorded as the
 * bounce — the stricter of the two.
 */
export async function suppressAddress(
  address: string,
  reason: SuppressionReason,
  source: string,
): Promise<void> {
  await connectToDatabase();
  const _id = normalizeAddress(address);

  const existing = await EmailSuppressionModel.findById(_id).select("reason");

  // Never downgrade a bounce or complaint to an unsubscribe.
  if (
    existing &&
    BLOCKS_TRANSACTIONAL.has(existing.reason) &&
    !BLOCKS_TRANSACTIONAL.has(reason)
  ) {
    return;
  }

  await EmailSuppressionModel.updateOne(
    { _id },
    { $set: { reason, source } },
    { upsert: true },
  );
}

export { EmailSuppressionModel };
