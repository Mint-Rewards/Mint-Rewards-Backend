import sendSecureEmail from "./emailFunction";

export default async function sendReferralEmail(recipientEmail: string) {
  try {
    const emailText = `Hello,

You’ve been referred to Mint Rewards! Join now and start earning rewards for recycling.

Sign up today and enjoy exclusive benefits.

Mint Rewards Team`;

    const info = await sendSecureEmail({
      from: '"Mint Rewards" <hello@mymintrewards.com>',
      to: recipientEmail,
      subject: "You've Been Referred to Mint Rewards!",
      html: `<p style="font-family: Arial, sans-serif; font-size: 16px; color: #333; line-height: 1.6;">
                        ${emailText.replace(/\n/g, "<br>")}
                      </p>`,
    });

    console.log("Email sent:", info.messageId);
  } catch (err: any) {
    console.error(
      `Failed to send referral email to ${recipientEmail}: ${err?.message || "unknown error"}`,
    );
  }
}
