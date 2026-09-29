/**
 * What actually exists in a Postgres database. Read-only, always.
 *
 * Written for the production cutover: two repositories migrate into one
 * Supabase instance, the backend into `consumer` and the operations API into
 * `public`, and "did that half of the schema ever get applied?" is not a
 * question worth guessing at.
 */
import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL must be set.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const { rows } = await pool.query(`
    SELECT table_schema AS schema, count(*) AS tables,
           string_agg(table_name, ', ' ORDER BY table_name) AS names
      FROM information_schema.tables
     WHERE table_type = 'BASE TABLE'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
     GROUP BY table_schema ORDER BY table_schema
  `);
  for (const r of rows) {
    console.log(`\n${r.schema} (${r.tables} tables)\n  ${r.names}`);
  }
} finally {
  await pool.end();
}
