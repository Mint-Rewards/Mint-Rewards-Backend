import { Resend } from "resend";
import { serverEnv, APP_ENV } from "@/lib/env";

type SendSecureEmailParams = {
  from: string;
  to: string;
  subject: string;
  html: string;
};

type ResolvedRecipient = {
  to: string;
  subject: string;
  redirected: boolean;
};

/**
 * Outside production, rewrite EVERY outbound message to the mail sink so a dev
 * deployment can never email a real user. This is the single choke point for
 * all mail in the codebase — every template under emailServices/ funnels
 * through sendSecureEmail below — so gating here covers signup confirmations,
 * password resets, verification codes, and the referral fan-out alike.
 *
 * The real recipient is preserved in the subject line rather than discarded,
 * so an engineer reading the sink can tell who a message was actually for.
 *
 * DEV_MAIL_REDIRECT_TO is required whenever APP_ENV !== "production"
 * (lib/env.ts), so this branch can never be reached with a null sink outside
 * production. It is rejected outright when APP_ENV === "production", so
 * production cannot be misconfigured into swallowing its own mail.
 *
 * Exported for direct unit testing — the redirect is the safety property that
 * matters most here, and verifying it should not require a live Resend call.
 */
export function resolveRecipient(
  to: string,
  subject: string,
): ResolvedRecipient {
  const sink = serverEnv.devMailRedirectTo;

  if (APP_ENV === "production" || !sink) {
    return { to, subject, redirected: false };
  }

  return {
    to: sink,
    subject: `[${APP_ENV} → ${to}] ${subject}`,
    redirected: true,
  };
}

export default async function sendSecureEmail({
  from,
  to,
  subject,
  html,
}: SendSecureEmailParams) {
  // Validated at boot in lib/env.ts.
  const resend = new Resend(serverEnv.resendApiKey);

  const recipient = resolveRecipient(to, subject);

  const { data, error } = await resend.emails.send({
    from,
    to: recipient.to,
    subject: recipient.subject,
    html,
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }

  // Keep the nodemailer-style shape callers log (info.messageId).
  return { messageId: data?.id ?? "" };
}
