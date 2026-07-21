import { Resend } from "resend";

type SendSecureEmailParams = {
  from: string;
  to: string;
  subject: string;
  html: string;
};

export default async function sendSecureEmail({
  from,
  to,
  subject,
  html,
}: SendSecureEmailParams) {
  const { RESEND_API_KEY } = process.env;

  if (!RESEND_API_KEY) {
    throw new Error("Missing RESEND_API_KEY env var");
  }

  const resend = new Resend(RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject,
    html,
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }

  // Keep the nodemailer-style shape callers log (info.messageId).
  return { messageId: data?.id ?? "" };
}
