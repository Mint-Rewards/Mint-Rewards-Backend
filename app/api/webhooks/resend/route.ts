import { serverEnv } from "@/lib/env";
import { verifySvixSignature } from "@/lib/svix";
import {
  suppressAddress,
  type SuppressionReason,
} from "@/lib/emailSuppression";

/**
 * Resend delivery events.
 *
 * Bounces and spam complaints were not merely unhandled before this — they
 * were unobservable (issue #145). Referral mail sends from the same domain as
 * OTP and password-reset mail, so complaints from recipients who never opted
 * in degrade deliverability for the auth mail the signup flow depends on.
 *
 * Register the endpoint in the Resend dashboard against
 * `<PUBLIC_BASE_URL>/api/webhooks/resend` and put the signing secret it issues
 * in RESEND_WEBHOOK_SECRET. Until that is done this route rejects everything:
 * an unsigned suppression endpoint would let anyone suppress any address,
 * which is a denial of service on password resets.
 */

/**
 * Only the events that mean "stop sending here".
 *
 * `email.bounced` covers soft bounces too, which is stricter than necessary —
 * a full mailbox is temporary. Resend does not distinguish the two in this
 * payload, and over-suppressing an address that can be cleared with
 * scripts/… is the safer side of that error than continuing to send at a
 * domain that is rejecting us.
 *
 * `email.delivered` and the open/click events are deliberately ignored: this
 * route exists to record failures, not to build an engagement profile of
 * people who never signed up.
 */
const EVENT_REASONS: Record<string, SuppressionReason> = {
  "email.bounced": "bounce",
  "email.complained": "complaint",
};

interface ResendEvent {
  type?: string;
  data?: { to?: string | string[]; email?: string };
}

function recipients(event: ResendEvent): string[] {
  const to = event.data?.to;
  if (Array.isArray(to)) return to.filter((v) => typeof v === "string");
  if (typeof to === "string") return [to];
  if (typeof event.data?.email === "string") return [event.data.email];
  return [];
}

export async function POST(req: Request): Promise<Response> {
  const secret = serverEnv.resendWebhookSecret;

  if (!secret) {
    console.error(
      "Resend webhook received but RESEND_WEBHOOK_SECRET is not set — " +
        "rejecting. Register the endpoint in Resend and set the secret.",
    );
    return Response.json({ error: "Not configured." }, { status: 503 });
  }

  // Read the raw body, not req.json(): the signature covers the exact bytes
  // sent, and re-serialising a parsed object does not reproduce them.
  const body = await req.text();

  const valid = verifySvixSignature(
    body,
    {
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    },
    secret,
  );

  if (!valid) {
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return Response.json({ error: "Malformed payload." }, { status: 400 });
  }

  const reason = event.type ? EVENT_REASONS[event.type] : undefined;

  // 200 for events we do not act on. A non-2xx would make Resend retry a
  // delivery that was never going to change anything.
  if (!reason) return Response.json({ ok: true, suppressed: 0 });

  const addresses = recipients(event);

  try {
    await Promise.all(
      addresses.map((address) =>
        suppressAddress(address, reason, `resend-webhook:${event.type}`),
      ),
    );
  } catch (error) {
    // 500 so Resend retries. Losing a bounce silently is how the list rots.
    console.error("Failed to record suppression from Resend webhook:", error);
    return Response.json({ error: "Failed to record." }, { status: 500 });
  }

  return Response.json({ ok: true, suppressed: addresses.length });
}
