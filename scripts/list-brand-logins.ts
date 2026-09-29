/**
 * Who can sign in to BrandHub. Read-only, always.
 *
 * Passwords are bcrypt hashes and cannot be recovered — this answers who
 * holds an account and which organisation it belongs to, not what they type.
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
    SELECT bu.email, bu.org_role, o.name AS organisation,
           (bu.password_hash LIKE '$2%') AS hash_looks_valid
      FROM consumer.brand_users bu
      LEFT JOIN consumer.organizations o ON o.id = bu.org_id
     ORDER BY o.name NULLS LAST, bu.email
  `);
  console.table(rows);
} finally {
  await pool.end();
}
