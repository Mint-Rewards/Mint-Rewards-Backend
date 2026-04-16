import sendSecureEmail from "./emailFunction";

export default async function sendPasswordResetEmail(
  recipientEmail: string,
  otp: string,
) {
  try {
    const info = await sendSecureEmail({
      from: '"Mint Rewards" <hello@mymintrewards.com>',
      to: recipientEmail,
      subject: "Password Reset - Your Password OTP",
      html: `<h3>Hello,</h3>
            <p>We have received a request to reset your password. Your otp is:</p>
            <h2>${otp}</h2>
            <p>Please use this otp to reset your password.</p>
            <br>
            <p>Thank you,</p>
            <p>Mint Rewards Team</p>`,
    });

    console.log("Email sent:", info.messageId);
  } catch (err: any) {
    throw new Error(
      `Failed to send email: ${err?.statusCode || err?.message || "unknown error"}`,
    );
  }
}
