import sendSecureEmail from "./emailFunction";

export default async function sendSignupEmail(
  recipientEmail: string,
  verificationLink: string,
) {
  try {
    const info = await sendSecureEmail({
      from: '"Mint Rewards" <hello@mymintrewards.com>',
      to: recipientEmail,
      subject: "Email Verification - Verify Your Email Address",
      html: `<h3>Hello,</h3>
<p>You are almost set to become part of the Mint family. Simply click the link below to verify your email address:</p>
<a href="${verificationLink}" style="color: #348eda; text-decoration: none;">Verify your email address</a>
<p>If you did not create an account, please ignore this email.</p>
<br />
<p>Thank you,</p>
<p>Mint Rewards Team</p>`,
    });

    console.log("Email sent:", info.messageId);
  } catch (err: any) {
    throw new Error(`Failed to send email: ${err?.message || String(err)}`);
  }
}
