import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { isProfileCompleteForBonus } from "@/lib/evaluateProfileCompletion";
import { UserModel } from "@/lib/models";
import { isCampaignLive, startProfileBonusWindow } from "@/lib/profileBonus";

export async function GET(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: {
        authorization: req.headers.get("authorization") ?? undefined,
      },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await UserModel.findById(userId).select("-password");

    if (!user) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    // DELIBERATE EXCEPTION: this GET can write, exactly once per user.
    //
    // Do not "fix" this back into a pure read. The profile-completion bonus
    // gives each user 24 hours from THEIR FIRST APP OPEN, and this endpoint is
    // the only reliable signal of an app open — the client's checkAuth() calls
    // it on every cold start, before any screen renders. A dedicated
    // "I opened the app" endpoint would need the client to cooperate and would
    // add a round-trip to every launch to record something we already learn
    // here.
    //
    // The write is scoped as tightly as it can be: only while a campaign is
    // live, only for a user who has not yet been paid, only for an INCOMPLETE
    // profile (someone already finished has nothing to earn and no window to
    // open), and the update itself is filtered on the field not existing. For
    // every user on every open after their first, this is zero writes.
    //
    // Stamp failures are swallowed inside startProfileBonusWindow — a bonus we
    // could not start must never cost the user their profile on a cold start.
    if (
      isCampaignLive() &&
      !user.profileBonusGrantedAt &&
      !user.profileBonusWindowStartedAt &&
      !isProfileCompleteForBonus(user)
    ) {
      const startedAt = await startProfileBonusWindow(userId);
      // Reflected onto the outgoing document so the client can render the
      // countdown on this very response. Without this the badge would not
      // appear until the user's SECOND open, by which point they have already
      // burned part of the window they were never told about.
      if (startedAt) user.profileBonusWindowStartedAt = startedAt;
    }

    return Response.json({
      user: user,
    });
  } catch {
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 400 },
    );
  }
}
