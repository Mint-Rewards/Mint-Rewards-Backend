/**
 * Gives a phone number to brands that arrived without one.
 *
 * `public.user_directory` — the view operations reads — requires a non-empty
 * phone, and `addBrandCollectionBranch` copies the brand's onto each premises.
 * Every brand migrated from Mongo came without one, so a brand could opt in,
 * name a branch and drop a pin, and the door would still never appear in the
 * console. Nothing reports it: the row is simply filtered out.
 *
 * The placeholder is deliberately not a plausible number. A captain who rings
 * it should fail obviously rather than reach a stranger, and `PLACEHOLDER`
 * below is greppable so the real numbers can be found and filled in later:
 *
 *   SELECT brand_name FROM consumer.brands WHERE phone = '+92-000-0000000';
 *
 * Idempotent: a brand that already has a phone is never overwritten.
 *
 *   node --experimental-strip-types scripts/backfill-brand-phones.ts --dry-run
 */
import pg from "pg";

const PLACEHOLDER = "+92-000-0000000";
const dryRun = process.argv.includes("--dry-run");
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL must be set.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows: before } = await client.query(
    `SELECT brand_name FROM consumer.brands
      WHERE COALESCE(btrim(phone), '') = '' ORDER BY brand_name`,
  );
  const { rows: doors } = await client.query(
    `SELECT u.user_name, b.brand_name
       FROM consumer.users u JOIN consumer.brands b ON b.id = u.brand_id
      WHERE u.account_type = 'BRAND' AND COALESCE(btrim(u.phone), '') = ''`,
  );

  console.log(`brands without a phone      ${before.length}`);
  console.log(`premises without a phone    ${doors.length}`);
  console.log(`mode                        ${dryRun ? "DRY RUN" : "WRITE"}\n`);
  for (const r of before) console.log(`  brand    ${r.brand_name}`);
  for (const d of doors)
    console.log(`  premises ${d.brand_name} — ${d.user_name}`);

  if (!dryRun) {
    await client.query("BEGIN");
    const b = await client.query(
      `UPDATE consumer.brands SET phone = $1, updated_at = now()
        WHERE COALESCE(btrim(phone), '') = ''`,
      [PLACEHOLDER],
    );
    // Existing premises too: they copied the empty value when they were made,
    // and fixing only the brand would leave today's doors still invisible.
    const u = await client.query(
      `UPDATE consumer.users SET phone = $1
        WHERE account_type = 'BRAND' AND COALESCE(btrim(phone), '') = ''`,
      [PLACEHOLDER],
    );
    await client.query("COMMIT");
    console.log(`\nbrands updated              ${b.rowCount}`);
    console.log(`premises updated            ${u.rowCount}`);

    const { rows: visible } = await client.query(
      `SELECT count(*) AS n FROM public.user_directory WHERE account_type = 'BRAND'`,
    );
    console.log(`brand doors now in directory ${visible[0].n}`);
  } else {
    console.log("\nDry run complete. Nothing was written.");
  }
} catch (error) {
  if (!dryRun) await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
