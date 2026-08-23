import sendSecureEmail, { SuppressedAddressError } from "./emailFunction";
import { serverEnv } from "@/lib/env";
import { escapeHtml } from "@/lib/escapeHtml";
import { sanitizeDisplayName } from "@/lib/sanitizeDisplayName";
import { unsubscribeUrl as buildUnsubscribeUrl } from "@/lib/unsubscribeToken";

/**
 * Store fallbacks for when IOS_STORE_URL / ANDROID_STORE_URL are unset.
 *
 * A search page is chosen over failing the send: this email's whole job is to
 * get somebody to the app, and a search result for the app's name reaches it,
 * whereas a thrown error reaches nobody. Invented store IDs are the option
 * NOT taken — a fabricated /id0000000000 is a dead link that looks alive.
 */
const APP_STORE_SEARCH = "https://apps.apple.com/search?term=Mint%20Rewards";
const PLAY_STORE_SEARCH =
  "https://play.google.com/store/search?q=Mint%20Rewards&c=apps";

const MINT = "#008081";
const INK = "#1F2A2E";
const MUTED = "#7EA295";

export interface ReferralEmailOptions {
  recipientEmail: string;
  /**
   * Display name of the person who sent the referral, if known. User-supplied
   * (UserModel.userName): sanitised once on entry, then escaped at every HTML
   * interpolation point.
   */
  referrerName?: string;
}

/**
 * The referral invitation.
 *
 * There is deliberately no referral code here. Attribution in this codebase
 * runs on exact email-address matching — awardReferralIfApplicable (lib/
 * referrals.ts) pays out when a new signup's address appears in some other
 * user's `referrals` array — so a code would have nothing to redeem against.
 * That mechanism is also why the body carries an explicit "sign up with this
 * address" line: a recipient who signs up with a different address silently
 * gets no payout, and nobody involved ever finds out why.
 *
 * Errors are logged rather than thrown, unlike the other three templates. The
 * one caller fans this out over up to 10 addresses in a Promise.all; one bad
 * recipient must not fail the other nine or the request itself.
 *
 * It returns whether the send succeeded rather than returning void. Swallowing
 * the error was correct; swallowing the *outcome* was not — the route used to
 * record every address as referred and answer "Referrals added successfully."
 * even when every send failed, which left the recipient permanently
 * unreachable through this feature (issue #144, defects 2-4). The caller now
 * records an address only once this returns true.
 */
export default async function sendReferralEmail({
  recipientEmail,
  referrerName,
}: ReferralEmailOptions): Promise<boolean> {
  try {
    // Sanitise before anything is built. The subject line is the reason this
    // cannot be a per-interpolation concern: it is not HTML, so escapeHtml
    // does not apply to it, and a CR or LF reaching it is header injection.
    // undefined here means "sanitised away to nothing" — the unnamed variant
    // takes over rather than a blank name being rendered.
    const referrer = sanitizeDisplayName(referrerName);

    const appStoreUrl = serverEnv.appConfig.iosStoreUrl ?? APP_STORE_SEARCH;
    const playStoreUrl =
      serverEnv.appConfig.androidStoreUrl ?? PLAY_STORE_SEARCH;
    const downloadUrl = serverEnv.appDownloadUrl;

    // Both parts read these two, so the footer cannot be fixed in one and left
    // stale in the other — the specific failure issue #145 calls out about the
    // postal address placeholder.
    const unsubscribeLink = buildUnsubscribeUrl(
      recipientEmail,
      serverEnv.publicBaseUrl,
    );
    const postalAddress = serverEnv.emailPostalAddress;

    const headline = referrer
      ? `${referrer} invited you to Mint Rewards`
      : "You've been invited to Mint Rewards";

    const intro = referrer
      ? `${referrer} earns rewards for recycling with Mint, and wants you in on it too!`
      : "Someone thought you'd want in on Mint Rewards — earn rewards every time you recycle.";

    const attribution = referrer
      ? `Sign up with this email address (${recipientEmail}) so ${referrer} gets their reward too.`
      : `Sign up with this email address (${recipientEmail}) so the person who invited you gets their reward too.`;

    const reward = referrer 
      ? "Do that and you'll both score a 100 point bonus, instantly. That's it. Recycle, earn, repeat." 
      : "Do that and you'll both score a 100 point bonus, instantly. That's it. Recycle, earn, repeat.";

    const preheader =
      "Download the app and start earning rewards for recycling.";

    // --- Plain text part ---------------------------------------------------
    // Built from the same variables as the HTML above it, so the two cannot
    // drift out of sync the way two hand-maintained copies would.
    const text = [
      headline,
      "",
      intro,
      "",
      attribution,
      "",
      ...(downloadUrl ? [`Download the app: ${downloadUrl}`, ""] : []),
      `iPhone: ${appStoreUrl}`,
      `Android: ${playStoreUrl}`,
      "",
      "— Mint Rewards Team",
      "",
      "You received this because someone shared Mint Rewards with you. We won't email you again unless you sign up.",
      `Unsubscribe: ${unsubscribeLink}`,
      `Mint Rewards · ${postalAddress}`,
    ].join("\n");

    // --- HTML part ---------------------------------------------------------
    // Buttons are a bgcolor'd table cell wrapping the anchor, not a styled
    // anchor: Outlook drops padding on a bare <a> and the button collapses to
    // its text.
    const button = (href: string, label: string) => `
                  <td bgcolor="${MINT}" style="border-radius:8px;">
                    <a href="${escapeHtml(href)}"
                       style="display:inline-block;padding:14px 30px;font-family:Arial,Helvetica,sans-serif;
                              font-size:16px;font-weight:bold;color:#FFFFFF;text-decoration:none;">
                      ${escapeHtml(label)}
                    </a>
                  </td>`;

    // One button when a UA-sniffing /download route is configured. Two when it
    // is not — offering both stores beats guessing which one the reader needs.
    const ctaCells = downloadUrl
      ? button(downloadUrl, "Get the app")
      : `${button(appStoreUrl, "App Store")}
                  <td style="width:12px;">&nbsp;</td>
                  ${button(playStoreUrl, "Google Play")}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#F6F7F7;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    ${escapeHtml(preheader)}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F6F7F7;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="max-width:600px;width:100%;background:#FFFFFF;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="padding:36px 32px 8px;font-family:Arial,Helvetica,sans-serif;">
              <div style="font-size:15px;font-weight:bold;color:${MINT};letter-spacing:.04em;">MINT REWARDS</div>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 0;font-family:Arial,Helvetica,sans-serif;">
              <h1 style="margin:0;font-size:26px;line-height:1.25;color:${INK};font-weight:bold;">
                ${escapeHtml(headline)}
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${INK};">
              ${escapeHtml(intro)}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="background:#F2F8F5;border-radius:10px;">
                <tr>
                  <td style="padding:16px 20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:${INK};">
                    ${escapeHtml(attribution)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>${ctaCells}
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${MUTED};">
              Or go straight to
              <a href="${escapeHtml(appStoreUrl)}" style="color:${MINT};">the App Store</a> or
              <a href="${escapeHtml(playStoreUrl)}" style="color:${MINT};">Google Play</a>.
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 32px;border-top:1px solid #E8ECEB;
                       font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:${MUTED};">
              You received this because someone shared Mint Rewards with you. We won't email you again unless you sign up.
              <br><a href="${escapeHtml(unsubscribeLink)}" style="color:${MUTED};">Unsubscribe</a>
              <br>Mint Rewards · ${escapeHtml(postalAddress)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const info = await sendSecureEmail({
      from: serverEnv.emailFrom,
      to: recipientEmail,
      subject: headline,
      html,
      text,
      // Nobody asked for this message, so it suppresses on an unsubscribe as
      // well as on the bounces and complaints that stop transactional mail.
      category: "outreach",
      unsubscribeUrl: unsubscribeLink,
    });

    console.log("Email sent:", info.messageId);
    return true;
  } catch (err) {
    // A suppressed address is an expected outcome, not a fault: the recipient
    // asked not to be emailed, or the address bounced. Logging it at error
    // level would train everyone to ignore the log that also carries real
    // send failures.
    if (err instanceof SuppressedAddressError) {
      console.log(`Referral email suppressed for ${recipientEmail}`);
      return false;
    }

    const message = err instanceof Error ? err.message : "unknown error";
    console.error(
      `Failed to send referral email to ${recipientEmail}: ${message}`,
    );
    return false;
  }
}
