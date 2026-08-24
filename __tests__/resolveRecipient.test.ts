import { resolveRecipient } from "@/emailServices/emailFunction";
import { APP_ENV, serverEnv } from "@/lib/env";

// Issue #146 item 4: lib/env.ts validated DEV_MAIL_REDIRECT_TO and documented
// it as rewriting every outbound message, while the implementation lived only
// in an unmerged worktree. Two real sends went to live addresses during the
// referral work as a result. These cases pin the behaviour to the branch that
// ships it, so the gap cannot silently reopen.
describe("resolveRecipient", () => {
  // The suite runs with APP_ENV=development (jest loads .env, and CI sets it
  // explicitly), so the sink is required to be present by lib/env.ts.
  it("runs against a non-production environment with a sink configured", () => {
    expect(APP_ENV).not.toBe("production");
    expect(serverEnv.devMailRedirectTo).toBeTruthy();
  });

  it("redirects a real recipient to the sink", () => {
    const resolved = resolveRecipient("victim@example.com", "Your OTP code");

    expect(resolved.redirected).toBe(true);
    expect(resolved.to).toBe(serverEnv.devMailRedirectTo);
    expect(resolved.to).not.toBe("victim@example.com");
  });

  it("preserves the intended recipient in the subject line", () => {
    // Discarding it would leave an engineer reading the sink unable to tell
    // who a message was actually for.
    const resolved = resolveRecipient("victim@example.com", "Your OTP code");

    expect(resolved.subject).toContain("victim@example.com");
    expect(resolved.subject).toContain("Your OTP code");
  });

  it("redirects referral mail, not just auth mail", () => {
    // The referral fan-out is the specific path that leaked twice.
    const resolved = resolveRecipient(
      "someone-who-never-signed-up@example.com",
      "Ada invited you to Mint Rewards",
    );

    expect(resolved.to).toBe(serverEnv.devMailRedirectTo);
  });
});
