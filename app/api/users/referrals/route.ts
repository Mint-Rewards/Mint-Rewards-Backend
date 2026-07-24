import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { UserModel } from "@/lib/models";
import sendReferralEmail from "@/emailServices/referralEmail";

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

    const user = await UserModel.findById(userId);

    if (!user) {
      return Response.json({ error: "User not found." }, { status: 404 });
    }

    user.referrals = [...new Set([...user.referrals, ...normalizedEmails])];
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
