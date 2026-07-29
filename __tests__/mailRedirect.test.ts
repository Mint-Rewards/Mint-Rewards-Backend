/// <reference types="jest" />

import { resolveRecipient } from "../emailServices/emailFunction";
import { APP_ENV, serverEnv } from "../lib/env";

// jest.setup.js pins APP_ENV=development and DEV_MAIL_REDIRECT_TO, so this
// suite exercises the non-production branch — the one that actually protects
// real users from a dev deployment.
describe("dev-only outbound mail redirect", () => {
  it("runs under a non-production APP_ENV with a sink configured", () => {
    expect(APP_ENV).not.toBe("production");
    expect(serverEnv.devMailRedirectTo).toBeTruthy();
  });

  it("rewrites the recipient to the sink regardless of the real address", () => {
    const result = resolveRecipient("realuser@example.com", "Welcome!");

    expect(result.to).toBe(serverEnv.devMailRedirectTo);
    expect(result.to).not.toBe("realuser@example.com");
    expect(result.redirected).toBe(true);
  });

  it("preserves the original recipient in the subject for triage", () => {
    const result = resolveRecipient("realuser@example.com", "Welcome!");

    expect(result.subject).toContain("realuser@example.com");
    expect(result.subject).toContain(APP_ENV);
    expect(result.subject).toContain("Welcome!");
  });

  it("redirects every distinct recipient to the same sink", () => {
    const recipients = [
      "a@example.com",
      "b@example.org",
      "c@subdomain.example.net",
    ];

    for (const address of recipients) {
      expect(resolveRecipient(address, "Referral").to).toBe(
        serverEnv.devMailRedirectTo,
      );
    }
  });
});
