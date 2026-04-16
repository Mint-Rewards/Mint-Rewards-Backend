import sendSecureEmail from "./emailFunction";

export default async function sendProfileCompletionEmail(
  recipientEmail: string,
  userName?: string,
) {
  try {
    const info = await sendSecureEmail({
      from: '"Mint Rewards" <hello@mymintrewards.com>',
      to: recipientEmail,
      subject: "Complete Your Profile to Unlock More Rewards",
      html: `<h3>Hello ${userName || "User"}</h3>
<p>Thank you for joining Mint Rewards! We noticed that your profile is missing phone or address information.</p>
<p>Complete your profile to access more personalized features and rewards.</p>
<p>If you have any questions, feel free to reach out.</p>
<br />
<p>Thank you,</p>
<p>Mint Rewards Team</p>`,
    });

    console.log("Email sent:", info.messageId);
  } catch (err: any) {
    throw new Error(
      `Failed to send profile completion email: ${err?.statusCode || err?.message || "unknown error"}`,
    );
  }
}
