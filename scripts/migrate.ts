/**
 * Applies the SQL under lib/db/migrations, in filename order, once each.
 *
 * Deliberately not drizzle-kit: the migrations here are hand-written because
 * several of them do things a schema differ cannot infer — creating the
 * `consumer` schema, CHECK constraints that mirror an application-level enum,
 * backfills. A generated diff would quietly drop those.
 *
 * Applied migrations are recorded in consumer.__migrations. Re-running is a
 * no-op, and each file runs inside a transaction, so a failure halfway leaves
 * nothing behind.
 *
 *   npm run db:migrate
 *   npm run db:migrate -- --dry-run
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const DIR = join(process.cwd(), "lib/db/migrations");

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set — nothing to migrate against.");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    // The bookkeeping table lives in the schema it tracks, so a dropped
    // schema takes its own history with it rather than leaving a stale ledger
    // claiming migrations that no longer exist.
    await pool.query("CREATE SCHEMA IF NOT EXISTS consumer");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consumer.__migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await pool.query<{ name: string }>(
      "SELECT name FROM consumer.__migrations",
    );
    const applied = new Set(rows.map((r) => r.name));

    const pending = files.filter((f) => !applied.has(f));
    const host = new URL(url).host;
    console.log(`target   ${host}`);
    console.log(`mode     ${dryRun ? "DRY RUN — nothing will be applied" : "APPLY"}`);
    console.log(`found    ${files.length} migration(s), ${pending.length} pending\n`);

    if (pending.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    for (const file of pending) {
      if (dryRun) {
        console.log(`  would apply  ${file}`);
        continue;
      }
      const sql = await readFile(join(DIR, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO consumer.__migrations (name) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        console.log(`  applied      ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        console.error(`  FAILED       ${file}`);
        throw error;
      } finally {
        client.release();
      }
    }
    console.log(`\n${dryRun ? "Dry run complete." : "Done."}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
