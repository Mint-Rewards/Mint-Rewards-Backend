/**
 * Postgres, alongside Mongo rather than instead of it.
 *
 * The migration off Mongo moves one model at a time, so for most of its life
 * this file and lib/mongodb.ts are both live and both authoritative — each for
 * the collections that have not yet moved, and the tables that have. Nothing
 * here reads or writes anything on its own; it exists so a ported model has a
 * handle to reach for.
 *
 * The pool is cached on `global` for the same reason the mongoose connection
 * is: Next hot-reloads this module on every edit in development, and a fresh
 * Pool per reload exhausts the server's connection slots within a few minutes.
 * The Jest carve-out matches mongodb.ts too — writing the cache onto `global`
 * trips jest-util's cross-test-file leak detection.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { serverEnv } from "@/lib/env";

type PostgresCache = {
  pool: pg.Pool | null;
  db: ReturnType<typeof drizzle> | null;
};

declare global {
  var __mintPostgres: PostgresCache | undefined;
}

const cached: PostgresCache = process.env.JEST_WORKER_ID
  ? { pool: null, db: null }
  : (global.__mintPostgres ??= { pool: null, db: null });

/**
 * Raised when something asks for Postgres on a deployment that has none.
 *
 * Distinct from a connection failure: this one is a configuration answer, and
 * a caller that can fall back to Mongo wants to tell the two apart.
 */
export class PostgresNotConfiguredError extends Error {
  constructor() {
    super(
      "DATABASE_URL is not set — this deployment has no Postgres. " +
        "During the Mongo migration that is a valid state, so callers that " +
        "can still read from Mongo should catch this rather than fail.",
    );
    this.name = "PostgresNotConfiguredError";
  }
}

export function isPostgresConfigured(): boolean {
  return serverEnv.databaseUrl !== null;
}

/**
 * The connection pool, opened on first use.
 *
 * `max` is deliberately small. On Vercel every concurrent invocation is its
 * own process with its own pool, so the ceiling that matters is Supabase's
 * total, not this number — and the transaction pooler in front of it is what
 * actually multiplexes. Ten per instance would exhaust the former without
 * helping the latter.
 */
export function getPool(): pg.Pool {
  if (!serverEnv.databaseUrl) throw new PostgresNotConfiguredError();
  cached.pool ??= new pg.Pool({
    connectionString: serverEnv.databaseUrl,
    max: 3,
    // A serverless invocation that cannot get a connection should fail while
    // the request is still alive, not hang until the platform kills it.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
  });
  return cached.pool;
}

/** The drizzle handle. Every ported model goes through this. */
export function getDb(): ReturnType<typeof drizzle> {
  cached.db ??= drizzle(getPool());
  return cached.db;
}

/**
 * Whether Postgres is reachable, for a health check.
 *
 * Returns a reason rather than throwing, because the caller is usually
 * reporting status rather than serving a request that needs the database.
 */
export async function checkPostgres(): Promise<
  { ok: true; latencyMs: number } | { ok: false; reason: string }
> {
  if (!isPostgresConfigured()) return { ok: false, reason: "not configured" };
  const started = Date.now();
  try {
    await getPool().query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Closes the pool. For tests and scripts; serverless never calls it. */
export async function closePostgres(): Promise<void> {
  if (cached.pool) {
    await cached.pool.end();
    cached.pool = null;
    cached.db = null;
  }
}
