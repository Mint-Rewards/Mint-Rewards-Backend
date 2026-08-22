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

    const normalizedEmails = Array.isArray(emails)
      ? emails
          .map((email) =>
            typeof email === "string" ? email.toLowerCase() : "",
          )
          .filter(Boolean)
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

    const existingReferrals = await UserModel.find({
      referrals: { $in: normalizedEmails },
    });

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

    const merged = [...new Set([...user.referrals, ...normalizedEmails])];
    user.referrals = merged;
    await user.save();

    await Promise.all(
      normalizedEmails.map((email) =>
        sendReferralEmail({
          recipientEmail: email,
          referrerName: user.userName,
        }),
      ),
    );

    return Response.json("Referrals added successfully.");
  } catch (error) {
    return Response.json(
      {
        error: "Your request could not be processed. Please try again.",
      },
      { status: 500 },
    );
  }
}
