/**
 * Delivering a one-time code over WhatsApp.
 *
 * Behind an interface because the sender is the part that is not ready: the
 * business number, the verified Meta account and the approved template are all
 * outside this codebase and none of them exists yet. Everything that depends
 * on sending can therefore be built, tested and reviewed now, and the day the
 * number arrives the only change is which implementation is selected.
 *
 * See docs/specs/phone-and-whatsapp-signup.md.
 */
import { serverEnv } from "@/lib/env";
import { displayPhone } from "@/lib/phoneNumber";

export type SendResult =
  | { ok: true; providerId: string | null }
  /**
   * `retryable` is the whole reason this is not a thrown error.
   *
   * A template Meta has paused and a momentary 503 need opposite handling —
   * one is an outage somebody must be told about, the other resolves itself.
   * Collapsing them into an exception loses that, and the caller then either
   * retries forever or gives up on both.
   */
  | { ok: false; error: string; retryable: boolean };

export interface OtpSender {
  /** For logs and for saying which path a code went down. */
  readonly name: string;
  /** `to` is always E.164. */
  send(to: string, code: string): Promise<SendResult>;
}

/**
 * The real one: Meta's Cloud API, authentication-category template.
 *
 * WhatsApp will not carry arbitrary text to somebody who has not messaged
 * first, so an OTP goes as an approved template whose wording Meta fixes and
 * into which we supply only the code. That is also why the body below looks
 * so constrained — there is no message to compose, only a variable to fill.
 *
 * Unverified against the live API, because there is no number to verify it
 * against yet. The shape follows Meta's documented authentication template
 * payload; treat the first real send as the test.
 */
export class WhatsAppCloudSender implements OtpSender {
  readonly name = "whatsapp-cloud";

  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
    private readonly template: string,
    private readonly language: string,
  ) {}

  async send(to: string, code: string): Promise<SendResult> {
    const url = `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          // Meta wants the number without a leading +.
          to: to.replace(/^\+/, ""),
          type: "template",
          template: {
            name: this.template,
            language: { code: this.language },
            components: [
              { type: "body", parameters: [{ type: "text", text: code }] },
              /*
               * The copy button carries the code too, and Meta requires it on
               * an authentication template. Without this component the send
               * is rejected as malformed rather than delivered plainly.
               */
              {
                type: "button",
                sub_type: "url",
                index: "0",
                parameters: [{ type: "text", text: code }],
              },
            ],
          },
        }),
      });

      const body = (await res.json().catch(() => null)) as {
        messages?: { id?: string }[];
        error?: { message?: string; code?: number };
      } | null;

      if (res.ok) return { ok: true, providerId: body?.messages?.[0]?.id ?? null };

      /*
       * 4xx is ours to fix — a bad token, a paused template, a number Meta
       * will not message. Retrying cannot help and would burn the rate limit
       * that protects somebody else's phone. 5xx and 429 pass.
       */
      const retryable = res.status >= 500 || res.status === 429;
      return {
        ok: false,
        error: body?.error?.message ?? `WhatsApp refused the send (${res.status}).`,
        retryable,
      };
    } catch (error) {
      // A network failure, not an answer. Always worth another go.
      return { ok: false, error: String((error as Error)?.message ?? error), retryable: true };
    }
  }
}

/**
 * The stand-in, until there is a number.
 *
 * Prints the code to the server log so a phone flow can be exercised
 * end to end with no provider at all — which is the only way any of this is
 * testable before the business account exists.
 *
 * It refuses to be constructed in production, loudly. The alternative is a
 * misconfigured deployment quietly writing live customers' one-time codes
 * into a log that support, analytics and anybody with log access can read.
 * A crash at startup is a bad morning; that is a breach.
 */
export class LoggingOtpSender implements OtpSender {
  readonly name = "logging-stub";

  constructor() {
    if (serverEnv.isProduction) {
      throw new Error(
        "LoggingOtpSender prints one-time codes and must never run in production. " +
          "Configure WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN.",
      );
    }
  }

  async send(to: string, code: string): Promise<SendResult> {
    console.log(`[otp] ${displayPhone(to)} -> ${code} (not sent; no provider configured)`);
    return { ok: true, providerId: null };
  }
}

/**
 * The sender this deployment should use.
 *
 * Configured or stubbed, and never silently stubbed in production — the throw
 * in the stub's constructor is what guarantees that. A production deployment
 * missing its WhatsApp settings fails at the first send with a message naming
 * exactly what is absent, rather than appearing to work.
 */
let cached: OtpSender | null = null;

export function otpSender(): OtpSender {
  if (cached) return cached;
  const { whatsappPhoneNumberId, whatsappAccessToken, whatsappOtpTemplate, whatsappOtpLanguage } =
    serverEnv;

  cached =
    whatsappPhoneNumberId && whatsappAccessToken
      ? new WhatsAppCloudSender(
          whatsappPhoneNumberId,
          whatsappAccessToken,
          whatsappOtpTemplate,
          whatsappOtpLanguage,
        )
      : new LoggingOtpSender();
  return cached;
}

/** For tests, which need to put their own sender in and take it out again. */
export function setOtpSender(sender: OtpSender | null): void {
  cached = sender;
}
