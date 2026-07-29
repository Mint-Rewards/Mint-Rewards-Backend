import sendSecureEmail from "./emailFunction";
import { serverEnv } from "@/lib/env";

export default async function sendSignupEmail(
  recipientEmail: string,
  otp: string,
) {
  try {
    const info = await sendSecureEmail({
      from: serverEnv.emailFrom,
      to: recipientEmail,
      subject: "Email Verification - Your Verification Code",
      html: `<h3>Hello,</h3>
<p>You are almost set to become part of the Mint family. Enter this code to verify your email address:</p>
<h2>${otp}</h2>
<p>This code expires in 10 minutes. If you did not create an account, please ignore this email.</p>
<br />
<p>Thank you,</p>
<p>Mint Rewards Team</p>`,
    });

    console.log("Email sent:", info.messageId);
  } catch (err: any) {
    throw new Error(`Failed to send email: ${err?.message || String(err)}`);
  }
}
