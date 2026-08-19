import { UserModel } from "@/lib/models";

export const REFERRAL_REWARD_POINTS = 50;

/**
 * Pays out a referral for a user who has just become verified.
 *
 * Idempotency lives on the *new* user's `referralRewardGranted` flag: the flag
 * flip and the new user's points are one atomic findOneAndUpdate filtered on
 * the flag being unset, so a second call for the same userId matches nothing
 * and neither side is paid twice. The referrer is looked up before that claim
 * so a user with no referrer never burns their flag.
 *
 * Never throws — a payout failure must not fail the verification that
 * triggered it. Mirrors the signup-email try/catch in users/signup/route.ts.
 */
export async function awardReferralIfApplicable(
  userId: unknown,
  email: unknown,
): Promise<void> {
  try {
    const normalizedEmail = String(email ?? "")
      .toLowerCase()
      .trim();
    if (!userId || !normalizedEmail) return;

    // Matches the old signup lookup, which took referralUsers[0]. Send-time
    // dedup means one referrer per address; findOne keeps the same tiebreak
    // for any historical rows that predate that check.
    const referrer = await UserModel.findOne({ referrals: normalizedEmail })
      .select("_id email")
      .lean();

    if (!referrer || String(referrer._id) === String(userId)) return;

    const claimed = await UserModel.findOneAndUpdate(
      { _id: userId, referralRewardGranted: { $ne: true } },
      {
        $set: { referralRewardGranted: true },
        $inc: { points: REFERRAL_REWARD_POINTS },
      },
    );

    // Already granted, or no such user. Do not pay the referrer either.
    if (!claimed) return;

    const paid = await UserModel.findOneAndUpdate(
      { _id: referrer._id },
      { $inc: { points: REFERRAL_REWARD_POINTS } },
    );

    if (!paid) {
      console.error(
        `Referral payout: referee ${userId} credited but referrer ${referrer._id} was not found.`,
      );
    }
  } catch (error) {
    console.error("Referral payout failed:", error);
  }
}
