/**
 * Removes the two accounts the user backfill supersedes.
 *
 * Mongo's unique index on email is case-SENSITIVE and Postgres's is not, so
 * two pairs that live happily in Mongo collide here. `backfill-users.ts`
 * picks a winner per pair and skips the loser — but an earlier, broken run
 * wrote some losers before the winner was reached, and those rows now hold
 * the address their winner needs.
 *
 * Hard-coded rather than recomputed: these are the exact two ids that run
 * reported, both with no name, no points and no collections, and a migration
 * clean-up that re-derives its own targets can widen without anyone noticing.
 */
import pg from "pg";

const SUPERSEDED = [
  "66d350c225771aeb15f6e9b5", // duplicate of malik.bejar@gmail.com
  "66d350c225771aeb15f6eae6", // duplicate of umama_hussain@yahoo.com
];

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL must be set.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const { rows: before } = await pool.query(
    `SELECT id, email, user_name, points, total_collections,
            jsonb_array_length(COALESCE(pickup_history, '[]'::jsonb)) AS pickups,
            (geog IS NOT NULL) AS has_pin,
            (device_token <> '') AS has_device
       FROM consumer.users WHERE id = ANY($1::text[])`,
    [SUPERSEDED],
  );
  if (before.length === 0) {
    console.log("Neither row is present. Nothing to do.");
  } else {
    console.table(before);
    /*
     * Refuses to drop an account anyone actually used.
     *
     * Points are not the test. Every account is granted SIGNUP_POINTS on
     * registration — 6,157 of production's 7,576 users sit at exactly that
     * and have never done anything — so `points > 0` would reject all of
     * them. What shows use is a pickup, a pin, a device that installed the
     * app, or a balance that grew past the grant.
     *
     * If one of these ever stops being empty, the duplicate needs merging,
     * not deleting, and that is a decision for a person.
     */
    const SIGNUP_POINTS = 100;
    const used = before.filter(
      (r) =>
        Number(r.pickups) > 0 ||
        Number(r.total_collections) > 0 ||
        r.has_pin ||
        r.has_device ||
        Number(r.points) > SIGNUP_POINTS,
    );
    if (used.length > 0) {
      throw new Error(
        `Refusing to delete: ${used.map((r) => r.id).join(", ")} has activity.`,
      );
    }
    const { rowCount } = await pool.query(
      `DELETE FROM consumer.users WHERE id = ANY($1::text[])`,
      [SUPERSEDED],
    );
    console.log(`\ndeleted ${rowCount} superseded account(s).`);
  }
} finally {
  await pool.end();
}
