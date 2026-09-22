/**
 * The Postgres handle, during the migration off Mongo.
 *
 * The case that matters most here is the absent one. For most of the
 * migration some deployments will have a DATABASE_URL and some will not, and
 * "not configured" has to stay a quiet, reportable answer rather than a crash
 * — anything that still reads from Mongo must be able to carry on.
 *
 * jest.setup.js deletes DATABASE_URL unless DATABASE_URL_TEST is set, so these
 * run against the unconfigured state by default and never reach live Supabase.
 */
import {
  PostgresNotConfiguredError,
  checkPostgres,
  closePostgres,
  getDb,
  getPool,
  isPostgresConfigured,
} from "@/lib/postgres";

const CONFIGURED = Boolean(process.env.DATABASE_URL);

afterAll(async () => {
  await closePostgres();
});

describe("postgres, when nothing is configured", () => {
  // Skipped rather than inverted when a test database is present: the point is
  // the behaviour of the absent case, and asserting it against a live pool
  // would only prove the guard was bypassed.
  const whenAbsent = CONFIGURED ? describe.skip : describe;

  whenAbsent("with no DATABASE_URL", () => {
    it("reports itself unconfigured", () => {
      expect(isPostgresConfigured()).toBe(false);
    });

    it("throws a named error rather than a connection failure", () => {
      // The distinction is the whole point: a caller that can fall back to
      // Mongo needs to tell "no Postgres here" from "Postgres is down".
      expect(() => getPool()).toThrow(PostgresNotConfiguredError);
      expect(() => getDb()).toThrow(PostgresNotConfiguredError);
    });

    it("explains itself in the message", () => {
      expect(() => getPool()).toThrow(/DATABASE_URL is not set/);
    });

    it("reports a reason instead of throwing, for health checks", async () => {
      // A status endpoint asks this while serving a request that does not
      // need the database, so it must not be the thing that fails.
      await expect(checkPostgres()).resolves.toEqual({
        ok: false,
        reason: "not configured",
      });
    });

    it("closes cleanly having never opened", async () => {
      await expect(closePostgres()).resolves.toBeUndefined();
    });
  });
});

describe("postgres, against a real database", () => {
  const whenPresent = CONFIGURED ? describe : describe.skip;

  whenPresent("with DATABASE_URL_TEST set", () => {
    it("reports itself configured", () => {
      expect(isPostgresConfigured()).toBe(true);
    });

    it("answers a health check with a latency", async () => {
      const result = await checkPostgres();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("hands back the same pool twice", () => {
      // Next re-imports this module on every edit; a fresh pool per reload
      // exhausts the server's connection slots within minutes.
      expect(getPool()).toBe(getPool());
      expect(getDb()).toBe(getDb());
    });
  });
});
