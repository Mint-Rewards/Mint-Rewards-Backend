import nodemailer from "nodemailer";

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
  const {
    NEXT_SMTP_HOST,
    NEXT_SMTP_PORT = "465",
    NEXT_SMTP_USERNAME,
    NEXT_SMTP_PASSWORD,
  } = process.env;

  if (!NEXT_SMTP_HOST || !NEXT_SMTP_USERNAME || !NEXT_SMTP_PASSWORD) {
    throw new Error(
      "Missing SMTP env vars (NEXT_SMTP_HOST, NEXT_SMTP_USERNAME, NEXT_SMTP_PASSWORD)",
    );
  }

  const transporter = nodemailer.createTransport({
    host: NEXT_SMTP_HOST,
    port: Number(NEXT_SMTP_PORT),
    secure: Number(NEXT_SMTP_PORT) === 465,
    auth: {
      user: NEXT_SMTP_USERNAME,
      pass: NEXT_SMTP_PASSWORD,
    },
  });

  return transporter.sendMail({
    from,
    to,
    subject,
    html,
  });
}
