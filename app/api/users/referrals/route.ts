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

const DAY_MS = 24 * 60 * 60 * 1000;
// Sends per referring user per day. The IP gate sits above it so one host
// can't cycle accounts to get around the per-user budget.
const MAX_SENDS_PER_USER_PER_DAY = 5;
const MAX_SENDS_PER_IP_PER_DAY = 20;
// Lifetime ceiling on how many addresses one user may ever refer.
const MAX_LIFETIME_REFERRALS = 20;

export async function POST(req: Request) {
  try {
    await connectToDatabase();

    const ipLimit = await checkRateLimit(
      "referrals:ip",
      clientIp(req),
      MAX_SENDS_PER_IP_PER_DAY,
      DAY_MS,
    );
    if (ipLimit.limited) return rateLimitResponse(ipLimit.retryAfterSeconds);

    const userId = await getAuthenticatedUserId({
      headers: {
        authorization: req.headers.get("authorization") ?? undefined,
      },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userLimit = await checkRateLimit(
      "referrals:user",
      hashKey(String(userId)),
      MAX_SENDS_PER_USER_PER_DAY,
      DAY_MS,
    );
    if (userLimit.limited) return rateLimitResponse(userLimit.retryAfterSeconds);

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

    // Cap on the merged set rather than on normalizedEmails.length, so
    // re-sending an address the user has already referred doesn't burn
    // headroom twice. Reject the whole batch instead of truncating it —
    // silently dropping addresses would report success for invites that
    // were never sent.
    const merged = [...new Set([...user.referrals, ...normalizedEmails])];

    if (merged.length > MAX_LIFETIME_REFERRALS) {
      const remaining = Math.max(
        0,
        MAX_LIFETIME_REFERRALS - user.referrals.length,
      );
      return Response.json(
        {
          error: `You can refer a maximum of ${MAX_LIFETIME_REFERRALS} people. You have ${remaining} referral${remaining === 1 ? "" : "s"} remaining.`,
          remaining,
        },
        { status: 400 },
      );
    }

    user.referrals = merged;
    await user.save();

    await Promise.all(
      normalizedEmails.map((email) => sendReferralEmail(email)),
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
