import { Pool } from "pg";
import { serverEnv } from "@/lib/env";

/**
 * The dual-write target. Mongo stays authoritative for the whole window; this
 * pool exists only so writes can be mirrored and later reconciled.
 *
 * Null whenever dual-write is off or POSTGRES_URL is unset, which is the
 * default. Every caller must treat null as "not configured" and carry on —
 * see lib/dualWrite.ts for why that is the only acceptable behaviour.
 */

declare global {
  // Reused across hot reloads, like the Mongoose cache next door. A new pool
  // per HMR cycle exhausts Postgres connections within a few file saves.
  var dualWritePool: Pool | null | undefined;
}

function create(): Pool | null {
  if (!serverEnv.dualWrite.enabled) return null;
  if (!serverEnv.dualWrite.postgresUrl) return null;
  const pool = new Pool({
    connectionString: serverEnv.dualWrite.postgresUrl,
    // Small: this is a shadow path. It must never be the reason the app runs
    // out of connections, and it must never queue behind itself.
    max: 4,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10_000,
  });
  // A pool with no error handler throws on an idle client dropping, which in
  // Node is an unhandled 'error' event and takes the process with it. That is
  // the opposite of failing open.
  pool.on("error", (err) => {
    console.error("[dual-write] idle Postgres client error:", err.message);
  });
  return pool;
}

export function dualWritePool(): Pool | null {
  if (process.env.JEST_WORKER_ID) {
    // Plain module-level cache under Jest, matching lib/mongodb.ts — writing
    // to `global` trips the cross-test global leak detector.
    return (moduleCache ??= create());
  }
  if (global.dualWritePool === undefined) global.dualWritePool = create();
  return global.dualWritePool;
}

let moduleCache: Pool | null | undefined;

/** Test seam: drop the cached pool so the next call re-reads configuration. */
export async function resetDualWritePool(): Promise<void> {
  const existing = process.env.JEST_WORKER_ID ? moduleCache : global.dualWritePool;
  if (existing) await existing.end().catch(() => {});
  moduleCache = undefined;
  global.dualWritePool = undefined;
}
