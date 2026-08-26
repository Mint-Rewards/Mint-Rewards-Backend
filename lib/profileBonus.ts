/**
 * The profile-completion bonus: N points for finishing your profile within a
 * per-user window that opens on their first app open.
 *
 * Structurally a sibling of lib/referrals.ts and deliberately so — that file is
 * the only existing precedent in this codebase for a guarded points grant, and
 * copying its shape means the two can be reasoned about together. Same
 * contract in particular:
 *
 *   - Idempotency is a FLAG PLUS A FILTERED ATOMIC UPDATE, never a read
 *     followed by a write. `profileBonusGrantedAt` plays the role
 *     `referralRewardGranted` plays there: the eligibility check and the
 *     payment are one `findOneAndUpdate`, so two concurrent calls cannot both
 *     match and nobody is paid twice.
 *   - It NEVER THROWS. A payout failure must not fail the profile save that
 *     triggered it. Losing a bonus is recoverable on the next save (the window
 *     is still open, the flag is still unset); losing the address the user just
 *     typed is not.
 *
 * There is no points ledger in this system — `points` is a bare Number on the
 * user — so `profileBonusGrantedAt` and `profileBonusPoints` are the entire
 * audit trail for this grant. That is a known, pre-existing gap shared with
 * referrals, not something this module introduces.
 */

import { isProfileCompleteForBonus } from "@/lib/evaluateProfileCompletion";
import { serverEnv } from "@/lib/env";
import { UserModel } from "@/lib/models";

const MS_PER_HOUR = 60 * 60 * 1000;

export interface ProfileBonusWindow {
  points: number;
  windowHours: number;
}

/**
 * Whether the campaign as a whole is running right now.
 *
 * Separate from the per-user window: this is the wall-clock period the offer
 * exists at all, and `profileBonusWindowStartedAt + windowHours` is one user's
 * slice of it. Both must hold to be paid.
 *
 * A null bound means unbounded on that end. Note this does NOT use
 * `isCampaignActive` from lib/campaignDates.ts: that helper treats a date-only
 * end as inclusive through local 23:59:59.999, which is right for a multi-week
 * deal and wrong for anything measured in hours.
 */
export function isCampaignLive(now: Date = new Date()): boolean {
  const { enabled, campaignStart, campaignEnd } = serverEnv.appConfig.profileBonus;
  if (!enabled) return false;

  const at = now.getTime();
  if (campaignStart && at < new Date(campaignStart).getTime()) return false;
  if (campaignEnd && at > new Date(campaignEnd).getTime()) return false;
  return true;
}

/**
 * Whether this user's own 24-hour window is still open.
 *
 * An unset `startedAt` is NOT open. The window has to have been stamped by an
 * actual app open (see GET /api/users/my-profile); treating "never opened the
 * app" as "window open" would pay users the offer was never shown to.
 */
export function isWindowOpen(
  startedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!startedAt) return false;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return false;
  const { windowHours } = serverEnv.appConfig.profileBonus;
  return now.getTime() - started <= windowHours * MS_PER_HOUR;
}

/**
 * Stamps the start of a user's bonus window, if it is not already stamped.
 *
 * Called from the app-open path (GET /api/users/my-profile). Filtered on the
 * field not existing, so it is a genuine no-op for every open after the first
 * — including under concurrency, where two simultaneous opens race and exactly
 * one wins. Returns the new Date if this call was the one that stamped it, or
 * null if it was already set, the user was gone, or the write failed.
 *
 * Never throws, for the same reason the payout doesn't: failing to stamp must
 * not fail the profile read that a cold start depends on.
 */
export async function startProfileBonusWindow(
  userId: unknown,
): Promise<Date | null> {
  try {
    if (!userId) return null;

    const startedAt = new Date();
    const stamped = await UserModel.findOneAndUpdate(
      { _id: userId, profileBonusWindowStartedAt: { $exists: false } },
      { $set: { profileBonusWindowStartedAt: startedAt } },
    );

    return stamped ? startedAt : null;
  } catch (error) {
    console.error("Profile bonus window stamp failed:", error);
    return null;
  }
}

/**
 * Pays the profile-completion bonus if this user has just earned it.
 *
 * Call after ANY write that could tip a profile into complete. Both of the
 * app's save paths qualify — `PUT /api/users/update-profile` and
 * `PATCH /api/users/location` — because the client's Edit Profile screen fires
 * them in sequence and either one can be the request that closes the last gap.
 * Calling it from both is safe by construction; that is what the idempotency
 * filter is for.
 *
 * The user is re-read here rather than accepted as an argument: the caller's
 * copy may predate its own write, and paying on a stale snapshot is exactly the
 * bug this ordering avoids.
 */
export async function awardProfileBonusIfEligible(
  userId: unknown,
): Promise<void> {
  try {
    if (!userId) return;

    const now = new Date();
    if (!isCampaignLive(now)) return;

    const user = await UserModel.findById(userId)
      .select(
        "userName phone city town townOther structuredAddress location locationVersion profileBonusWindowStartedAt profileBonusGrantedAt",
      )
      .lean();

    if (!user) return;
    // Cheap checks before the completion evaluation, which touches the registry.
    if (user.profileBonusGrantedAt) return;
    if (!isWindowOpen(user.profileBonusWindowStartedAt, now)) return;
    if (!isProfileCompleteForBonus(user)) return;

    const { points } = serverEnv.appConfig.profileBonus;

    // The claim. `$exists: false` on the grant stamp is the whole idempotency
    // story: a second call — concurrent or minutes later — matches no document
    // and increments nothing. Re-checking `profileBonusGrantedAt` above is only
    // an optimisation; THIS is the guarantee.
    const paid = await UserModel.findOneAndUpdate(
      { _id: userId, profileBonusGrantedAt: { $exists: false } },
      {
        $set: { profileBonusGrantedAt: now, profileBonusPoints: points },
        $inc: { points },
      },
    );

    if (paid) {
      console.info(
        `Profile bonus: paid ${points} points to ${String(userId)}.`,
      );
    }
  } catch (error) {
    console.error("Profile bonus payout failed:", error);
  }
}
