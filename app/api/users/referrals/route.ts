import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { UserModel } from "@/lib/models";
import sendReferralEmail from "@/emailServices/referralEmail";
import {
  checkRateLimit,
  clientIp,
  hashKey,
  rateLimitResponse,
} from "@/lib/rateLimit";
import { isValidEmail } from "@/lib/emailFormat";

export async function POST(req: Request) {
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

    // Mirrors the two-check shape used by every other rate-limited route
    // (signup, login, resend-verification-otp): IP first, then the identity
    // the endpoint actually acts on.
    //
    // The per-user check is the one that matters here. This route is
    // authenticated and each request fans out to as many as 10 addresses that
    // never opted in, so the abuse unit is the account, not the connection —
    // and behind carrier NAT an IP-only cap punishes bystanders. 3 requests
    // per hour puts the ceiling at 30 invitations an hour per account, which
    // is generous for someone inviting their household and useless to anyone
    // mining the endpoint for outbound mail off the auth sending domain.
    //
    // The IP check stays as the outer bound on a single host cycling accounts.
    const ipLimit = await checkRateLimit(
      "referrals:ip",
      clientIp(req),
      10,
      60 * 60 * 1000,
    );
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const userLimit = await checkRateLimit(
      "referrals:user",
      hashKey(String(userId)),
      3,
      60 * 60 * 1000,
    );
    if (userLimit.limited)
      return rateLimitResponse(userLimit.retryAfterSeconds);

    const body = await req.json();
    const { emails } = body as { emails?: string[] };

    // trim() before lowercase, and a Set to collapse repeats inside one batch.
    // Both feed the same string-equality comparison the dedupe below relies on:
    // " Victim@X.com " and "victim@x.com" are one address to a mail server, and
    // were two distinct keys here until the trim was added.
    //
    // Malformed entries are dropped silently rather than 400-ing the request.
    // A 400 naming the offender would be friendlier, but the same response
    // would then distinguish "malformed" from "registered" — and 6a's whole
    // point is that this endpoint must not answer questions about an address
    // it was handed. The client validates format on blur already, so a
    // malformed address arriving here is not the normal path.
    const normalizedEmails = Array.isArray(emails)
      ? [
          ...new Set(
            emails
              .map((email) =>
                typeof email === "string" ? email.trim().toLowerCase() : "",
              )
              .filter((email) => email !== "" && isValidEmail(email)),
          ),
        ]
      : [];

    if (!normalizedEmails.length) {
      return Response.json(
        { error: "Emails must be provided." },
        { status: 400 },
      );
    }

    if (normalizedEmails.length > 10) {
      return Response.json(
        { error: "A maximum of 10 emails can be referred at once." },
        { status: 400 },
      );
    }

    const user = await UserModel.findById(userId);

    if (!user) {
      return Response.json({ error: "User not found." }, { status: 404 });
    }

    // Self-referral is the one rejection that still fails the whole request.
    // It discloses nothing the caller does not already know — they are the
    // authenticated owner of this address — and it is a client bug rather
    // than an ordinary batch outcome.
    if (normalizedEmails.includes(user.email)) {
      return Response.json(
        { error: "You cannot refer your own email address." },
        { status: 400 },
      );
    }

    // One round trip answers both questions: who already holds these addresses
    // in their referrals array, and which of them are registered accounts.
    // `email` is unique and therefore indexed; `referrals` is indexed by the
    // schema (lib/models.ts). Selecting only the two fields keeps this off the
    // full documents.
    const matches = await UserModel.find({
      $or: [
        { referrals: { $in: normalizedEmails } },
        { email: { $in: normalizedEmails } },
      ],
    }).select("email referrals");

    const registered = new Set(
      matches
        .map((match) => match.email)
        .filter((email) => normalizedEmails.includes(email)),
    );

    // Global, not per-referrer: an address already invited by ANY user is not
    // invited again. That is the existing dedupe rule and it is unchanged.
    // What changed is the consequence — it now removes one address from the
    // batch instead of rejecting the batch (issue #144 defect 1). The pool of
    // colliding addresses grows with every invitation ever sent platform-wide,
    // so a batch-killing rule degraded as the platform grew.
    const alreadyReferred = new Set(
      matches.flatMap((match) =>
        match.referrals.filter((email) => normalizedEmails.includes(email)),
      ),
    );

    // Registered addresses are skipped silently — no mail, and no mention in
    // the response. Reporting them the way the old 400 reported collisions
    // would turn this endpoint into an account-existence oracle: POST an
    // address, read the response, learn whether that person has an account.
    //
    // They are deliberately NOT written to user.referrals. The array's only
    // consumer is awardReferralIfApplicable (lib/referrals.ts), which pays out
    // when a NEW signup's address appears in it — an address that is already
    // an account can never trigger that, so recording it buys nothing and
    // costs the referrer the ability to refer that address again should the
    // recipient later delete their account.
    const sendable = normalizedEmails.filter(
      (email) => !registered.has(email) && !alreadyReferred.has(email),
    );

    // Send FIRST, record after. The previous order recorded every sendable
    // address before the fan-out, and referralEmail swallows its errors, so a
    // permanently bouncing address was written to `referrals` and — because
    // the dedupe is global — could never be referred by anyone again. Nobody
    // was told, and there was no route to clear the entry. Now an address that
    // fails to send is simply never recorded, which leaves it retryable by
    // construction rather than by an admin action.
    const outcomes = await Promise.all(
      sendable.map(async (email) => ({
        email,
        sent: await sendReferralEmail({
          recipientEmail: email,
          referrerName: user.userName,
        }),
      })),
    );

    const sentEmails = outcomes
      .filter((outcome) => outcome.sent)
      .map((outcome) => outcome.email);

    if (sentEmails.length > 0) {
      user.referrals = [...new Set([...user.referrals, ...sentEmails])];
      await user.save();
    }

    // Counts only, and one `skipped` bucket rather than a breakdown.
    //
    // The client needs real numbers to stop reporting the submitted count as
    // the sent count (defect 5). It does not need the reasons, and publishing
    // them would rebuild the oracle the silent skip exists to prevent: a
    // per-reason breakdown over a single-address batch names the reason
    // outright. Collapsing already-referred, registered, and failed into one
    // number leaves a prober knowing only that some address in the batch was
    // not invitable, without which of the three causes applied.
    //
    // Residual, and accepted: a single-address batch still distinguishes
    // "invitable" from "not invitable". Closing that completely means either
    // lying about the counts or refusing single-address batches, and both are
    // worse than an ambiguous negative.
    return Response.json({
      requested: normalizedEmails.length,
      sent: sentEmails.length,
      skipped: normalizedEmails.length - sentEmails.length,
    });
  } catch {
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
