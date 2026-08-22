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

    const existingReferrals = matches.filter((match) =>
      match.referrals.some((email) => normalizedEmails.includes(email)),
    );

    if (existingReferrals.length > 0) {
      const alreadyReferredEmails: string[] = [];
      existingReferrals.forEach((user) => {
        alreadyReferredEmails.push(
          ...user.referrals.filter((email) => normalizedEmails.includes(email)),
        );
      });

      return Response.json(
        {
          error: "These emails have already been referred.",
          emails: alreadyReferredEmails,
        },
        { status: 400 },
      );
    }

    // Registered addresses are skipped silently — no mail, and no mention in
    // the response. Reporting them the way the 400 above reports collisions
    // would turn this endpoint into an account-existence oracle: POST an
    // address, read the response, learn whether that person has an account.
    //
    // They are deliberately NOT written to user.referrals. The array's only
    // consumer is awardReferralIfApplicable (lib/referrals.ts), which pays out
    // when a NEW signup's address appears in it — an address that is already
    // an account can never trigger that, so recording it buys nothing and
    // costs the referrer the ability to refer that address again should the
    // recipient later delete their account. A repeat POST simply re-runs this
    // same indexed lookup, which is harmless.
    const sendable = normalizedEmails.filter((email) => !registered.has(email));

    if (sendable.length > 0) {
      const merged = [...new Set([...user.referrals, ...sendable])];
      user.referrals = merged;
      await user.save();
    }

    await Promise.all(
      sendable.map((email) =>
        sendReferralEmail({
          recipientEmail: email,
          referrerName: user.userName,
        }),
      ),
    );

    return Response.json("Referrals added successfully.");
  } catch {
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
