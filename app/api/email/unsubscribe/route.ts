import { suppressAddress, normalizeAddress } from "@/lib/emailSuppression";
import { verifyUnsubscribeToken } from "@/lib/unsubscribeToken";
import { isValidEmail } from "@/lib/emailFormat";

/**
 * Unauthenticated unsubscribe.
 *
 * No session, by design: the recipient of a referral invitation does not have
 * an account, which is exactly why they want out. The signed token in the link
 * is the authorisation — see lib/unsubscribeToken.ts.
 *
 * GET suppresses immediately and renders a confirmation, rather than showing a
 * button that must be clicked. A link scanner or prefetcher can therefore
 * unsubscribe someone who never asked; that is the accepted trade in RFC 8058
 * and everywhere else, because the alternative failure — a person who wants
 * out clicks the link, sees a form, and gets more mail — is the one that turns
 * into a spam complaint against the sending domain.
 *
 * POST handles the same request from a mail client's native one-click button.
 */

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Mint Rewards</title>
</head>
<body style="margin:0;background:#F6F7F7;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:520px;margin:64px auto;background:#FFFFFF;border-radius:14px;padding:36px 32px;">
    <div style="font-size:15px;font-weight:bold;color:#008081;letter-spacing:.04em;">MINT REWARDS</div>
    <h1 style="margin:12px 0 0;font-size:24px;line-height:1.3;color:#1F2A2E;">${title}</h1>
    <p style="margin:16px 0 0;font-size:16px;line-height:1.6;color:#1F2A2E;">${body}</p>
  </div>
</body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Never let a shared cache serve one person's unsubscribe result to
        // the next reader, and keep the address out of search indexes.
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      },
    },
  );
}

async function unsubscribe(req: Request): Promise<{ ok: boolean }> {
  const url = new URL(req.url);
  const rawEmail = url.searchParams.get("email") ?? "";
  const token = url.searchParams.get("token") ?? "";

  const email = normalizeAddress(rawEmail);

  if (!email || !isValidEmail(email)) return { ok: false };
  if (!verifyUnsubscribeToken(email, token)) return { ok: false };

  await suppressAddress(email, "unsubscribe", "unsubscribe-link");
  return { ok: true };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ok } = await unsubscribe(req);

    if (!ok) {
      // One message for a bad token and for a malformed address alike. A
      // response that told them apart would confirm which addresses this
      // system knows about, which is the same disclosure the referral route
      // is careful not to make.
      return page(
        "This link isn't valid",
        "It may have been copied incompletely. Forward the original email to " +
          "support@mymintrewards.com and we'll unsubscribe you by hand.",
        400,
      );
    }

    return page(
      "You're unsubscribed",
      "You won't receive further invitations or announcements from Mint " +
        "Rewards at this address. If you have an account with us, messages " +
        "you ask for — password resets and verification codes — will still " +
        "reach you.",
      200,
    );
  } catch (error) {
    console.error("Unsubscribe failed:", error);
    return page(
      "Something went wrong",
      "We couldn't process that just now. Please try the link again shortly.",
      500,
    );
  }
}

/**
 * RFC 8058 one-click. The mail client POSTs with no body it expects back, so
 * this answers 200 with nothing rather than the HTML page.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const { ok } = await unsubscribe(req);
    return new Response(null, { status: ok ? 200 : 400 });
  } catch (error) {
    console.error("Unsubscribe (one-click) failed:", error);
    return new Response(null, { status: 500 });
  }
}
