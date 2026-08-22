import { Resend } from "resend";
import { serverEnv, APP_ENV } from "@/lib/env";
import { isSuppressed, type MailCategory } from "@/lib/emailSuppression";

type SendSecureEmailParams = {
  from: string;
  to: string;
  subject: string;
  html: string;
  /**
   * Optional plain-text alternative part. Templates that supply one get a
   * multipart/alternative message; the three that do not are unaffected.
   */
  text?: string;
  /**
   * What kind of mail this is. Defaults to "transactional" — the safe default
   * for the three templates that predate suppression, all of which are sent
   * in response to the recipient's own action. Outreach must opt in, and
   * suppresses more aggressively; see lib/emailSuppression.ts.
   */
  category?: MailCategory;
  /**
   * Absolute URL that unsubscribes this recipient. Outreach mail must supply
   * one: it becomes the List-Unsubscribe header, which is what mail clients
   * offer as a native "unsubscribe" button, and what keeps a reader who wants
   * out from reaching for "report spam" instead.
   */
  unsubscribeUrl?: string;
};

/** Thrown when a send is refused because the address is suppressed. */
export class SuppressedAddressError extends Error {
  constructor(address: string) {
    super(`Refusing to send: ${address} is suppressed`);
    this.name = "SuppressedAddressError";
  }
}

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
  text,
  category = "transactional",
  unsubscribeUrl,
}: SendSecureEmailParams) {
  // Suppression is checked here, at the single choke point every template in
  // emailServices/ funnels through, rather than in the one template that
  // prompted issue #145. A per-template check is a check somebody forgets to
  // add to the next template.
  //
  // Checked against the REAL recipient, before resolveRecipient rewrites it:
  // outside production every address becomes the sink, and testing the sink
  // for suppression would answer a question about the wrong person.
  if (await isSuppressed(to, category)) {
    throw new SuppressedAddressError(to);
  }

  // Validated at boot in lib/env.ts.
  const resend = new Resend(serverEnv.resendApiKey);

  const recipient = resolveRecipient(to, subject);

  // RFC 8058 one-click. List-Unsubscribe-Post is what makes a mail client's
  // own button work without opening a browser, and it is only honoured when
  // it appears alongside List-Unsubscribe.
  const headers = unsubscribeUrl
    ? {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    : undefined;

  const { data, error } = await resend.emails.send({
    from,
    to: recipient.to,
    subject: recipient.subject,
    html,
    ...(text === undefined ? {} : { text }),
    ...(headers === undefined ? {} : { headers }),
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }

  // Keep the nodemailer-style shape callers log (info.messageId).
  return { messageId: data?.id ?? "" };
}
