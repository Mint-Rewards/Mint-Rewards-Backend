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

// Postgres, during the migration off Mongo. Same rule as above: a test run
// must never reach the live database. There is no Postgres test instance yet,
// so the default is to unset it entirely, which makes lib/postgres report
// "not configured" — the state every suite currently expects. Point
// DATABASE_URL_TEST at a throwaway Postgres to exercise the real thing.
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
} else {
  delete process.env.DATABASE_URL;
}
