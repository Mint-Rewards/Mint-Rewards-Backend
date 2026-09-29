/**
 * How far the production backfills have got. Read-only, always.
 *
 * Exists so progress can be watched without opening a SQL prompt against
 * production — the only statements here are counts, and there is nothing in
 * this file that can write.
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
    SELECT 'users' AS table, count(*) AS rows FROM consumer.users
    UNION ALL SELECT 'users with a pin', count(*) FROM consumer.users WHERE geog IS NOT NULL
    UNION ALL SELECT 'organizations', count(*) FROM consumer.organizations
    UNION ALL SELECT 'brand_users', count(*) FROM consumer.brand_users
    UNION ALL SELECT 'brands', count(*) FROM consumer.brands
    UNION ALL SELECT 'campaigns', count(*) FROM consumer.campaigns
    UNION ALL SELECT 'deals', count(*) FROM consumer.deals
    UNION ALL SELECT 'logs', count(*) FROM consumer.logs
    UNION ALL SELECT '-- operations --', 0
    UNION ALL SELECT 'admins', count(*) FROM public.admins
    UNION ALL SELECT 'admin_roles', count(*) FROM public.admin_roles
    UNION ALL SELECT 'admin_permissions', count(*) FROM public.admin_permissions
    UNION ALL SELECT 'collection_zones', count(*) FROM public.collection_zones
    UNION ALL SELECT 'collections', count(*) FROM public.collections
    UNION ALL SELECT 'captains', count(*) FROM public.captains
  `);
  console.table(rows);
} finally {
  await pool.end();
}
