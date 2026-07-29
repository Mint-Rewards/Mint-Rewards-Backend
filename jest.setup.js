// Runs after dotenv/config (see jest.setupFiles order in package.json).
// Point jest at the isolated test database so suites never touch the
// production mint_rewards DB. MONGODB_URI_TEST lives in .env.
if (process.env.MONGODB_URI_TEST) {
  process.env.MONGODB_URI = process.env.MONGODB_URI_TEST;
} else {
  // Fail loudly rather than silently running tests against production.
  throw new Error(
    "MONGODB_URI_TEST is not set — refusing to run jest against the primary database. " +
      "Define MONGODB_URI_TEST in .env (a separate test database).",
  );
}

// lib/env.ts validates every required key at module load, so importing any
// route under test pulls the full config in. Supply inert stand-ins for
// anything the suite does not genuinely exercise, so a developer without a
// full production .env can still run the tests.
//
// Only defaults what is ABSENT — a real value in .env always wins, and nothing
// here points at a real resource. MONGODB_URI is deliberately not defaulted:
// the guard above owns that decision.
const TEST_DEFAULTS = {
  APP_ENV: "development",
  JWT_SECRET: "test-jwt-secret-not-for-production",
  BRANDHUB_JWT_SECRET: "test-brandhub-secret-not-for-production",
  ADMIN_JWT_SECRET: "test-admin-secret-not-for-production",
  ADMIN_EMAIL: "admin@test.invalid",
  // bcrypt-shaped stand-in; never a valid credential anywhere real.
  ADMIN_PASSWORD_HASH:
    "$2b$10$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU",
  OTP_PEPPER: "test-otp-pepper-not-for-production",
  GOOGLE_IOS_CLIENT_ID: "test-ios-client-id.apps.googleusercontent.invalid",
  GOOGLE_WEB_CLIENT_ID: "test-web-client-id.apps.googleusercontent.invalid",
  APPLE_BUNDLE_ID: "com.mintrewards.app.test",
  RESEND_API_KEY: "re_test_key_not_for_production",
  EMAIL_FROM: '"Mint Rewards (test)" <noreply@test.invalid>',
  // APP_ENV is "development" above, so the mail sink is required.
  DEV_MAIL_REDIRECT_TO: "engineering@test.invalid",
  BLOB_PUBLIC_READ_WRITE_TOKEN: "vercel_blob_rw_TESTTOKEN_not_for_production",
  ALLOWED_ORIGINS: "http://localhost:5173",
};

for (const [key, value] of Object.entries(TEST_DEFAULTS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
