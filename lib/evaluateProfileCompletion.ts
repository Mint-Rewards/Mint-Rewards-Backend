/**
 * "Has this user finished their profile?" — the server-side predicate the
 * profile-completion bonus is paid on.
 *
 * This is deliberately NOT a new definition of completeness. It is
 * `evaluateLocation` (the declared single source of location-completion truth)
 * plus the two identity fields the user is actually shown a row for.
 *
 * Why not reuse the predicate that already exists? `update-profile` tests
 * `phone && address` before paying a referral, and that is far looser than the
 * gate the user sees: it ignores the map pin and the house number entirely, so
 * a user who has typed a free-text street and nothing else would satisfy it
 * while the app still shows them "Finish your profile". Paying on that
 * predicate would pay people the app is still nagging. It is left alone here
 * rather than tightened, because referral payout has its own history and its
 * own population, and widening this change to cover it would move money for
 * reasons unrelated to this campaign.
 *
 * Why these two identity fields and no others? They are exactly the rows
 * `FinishProfileModal` can leave outstanding. The modal's five rows are Name,
 * Email, Phone Number, Pickup address and Map pin; Email is set at signup and
 * is never tappable, and Pickup address + Map pin are what `evaluateLocation`
 * already judges. So `userName` and `phone` are the remainder. See
 * `missingFields` in the client's utils/locationGate.ts, which enumerates the
 * same set.
 *
 * The client's `isProfileComplete` (utils/profile.ts) is a NEAR-twin of this
 * and is not authoritative: it additionally demands `province`, which this app
 * never asks a user for, and it reads the legacy `latitude`/`longitude` strings
 * rather than the structured pin. The two cannot be made to agree — the server
 * judges the structured record and the client judges its own form fields — and
 * where they disagree, THIS one decides the payout, because it is the only one
 * that cannot be edited by the person being paid.
 */

import { evaluateLocation, type EvaluableUser } from "@/lib/evaluateLocation";

/** "Non-empty" means non-empty after trim, matching evaluateLocation. */
function nonEmpty(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export type ProfileCompletableUser = EvaluableUser & {
  userName?: string;
  phone?: string;
};

export function isProfileCompleteForBonus(
  user: ProfileCompletableUser | null | undefined,
): boolean {
  if (!user) return false;
  return (
    evaluateLocation(user).complete &&
    nonEmpty(user.userName) &&
    nonEmpty(user.phone)
  );
}
