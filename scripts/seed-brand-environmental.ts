/**
 * Gives a brand a believable ESG history.
 *
 * `consumer.brands.environmental_periods` is a jsonb array of dated buckets,
 * and the BrandHub analytics route sums the ones overlapping the statistics
 * period. A brand with none shows an ESG tab full of zeroes, which demos
 * nothing and — worse — looks like the feature is broken rather than the data
 * being absent.
 *
 * Twelve monthly buckets, so the date picker actually does something: narrow
 * the window and the tonnage moves, which is the whole point of bucketing.
 *
 * CO₂ per bucket is computed from its own material split using the same
 * factors as the public calculator at mintrewards.app — paper and cardboard
 * 3.3, plastic 2.0, glass 0.5, aluminium 9.0 kg CO₂ saved per kg. Seeded data
 * that contradicts the company's own published arithmetic is worse than no
 * data, because somebody will check.
 *
 *   node --experimental-strip-types scripts/seed-brand-environmental.ts --brand "Crumble" --dry-run
 *   node --experimental-strip-types scripts/seed-brand-environmental.ts --brand "Crumble"
 */
import pg from "pg";

const CO2_PER_KG: Record<string, number> = {
  Paper: 3.3,
  Cardboard: 3.3,
  Plastic: 2.0,
  Glass: 0.5,
  Aluminium: 9.0,
};

/**
 * Roughly what a food brand's recovered stream looks like by weight.
 *
 * Cardboard dominates because packaging does; aluminium is a sliver because it
 * is light, even where there is a lot of it. These shares are what make the
 * pie chart look like a real business rather than four equal quarters.
 */
const MIX: Record<string, number> = {
  Cardboard: 0.42,
  Paper: 0.18,
  Plastic: 0.27,
  Glass: 0.09,
  Aluminium: 0.04,
};

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const dryRun = process.argv.includes("--dry-run");
const brandName = arg("brand");
const months = Number(arg("months") ?? 12);
const url = process.env.DATABASE_URL?.trim();

if (!url || !brandName) {
  console.error(
    "Usage: --brand <name> [--months 12] [--dry-run], with DATABASE_URL set.",
  );
  process.exit(1);
}

const round1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * A month's figures.
 *
 * Deterministic from the month index rather than random, so re-running
 * produces the same history. A demo that changes its numbers between two
 * refreshes invites exactly the question you do not want on stage.
 */
function bucketFor(monthsAgo: number) {
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - monthsAgo, 1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);

  // A gentle upward trend with a seasonal wobble: recovery grows as a brand
  // settles into the programme, and dips over holidays.
  const base = 180 + (months - monthsAgo) * 14;
  const wobble = 1 + 0.18 * Math.sin(monthsAgo * 1.1);
  const totalWasteKg = round1(base * wobble);

  const materialBreakdown = Object.entries(MIX).map(([material, share]) => ({
    material,
    weightKg: round1(totalWasteKg * share),
  }));

  const co2AvoidedKg = round2(
    materialBreakdown.reduce(
      (sum, m) => sum + m.weightKg * (CO2_PER_KG[m.material] ?? 1),
      0,
    ),
  );

  return {
    periodStart: day(start),
    periodEnd: day(end),
    // The sum of the parts, not the figure above: a breakdown whose rows do
    // not add up to its total is the first thing a sceptical viewer notices.
    totalWasteKg: round1(
      materialBreakdown.reduce((sum, m) => sum + m.weightKg, 0),
    ),
    co2AvoidedKg,
    materialBreakdown,
  };
}

const periods = Array.from({ length: months }, (_, i) =>
  bucketFor(months - 1 - i),
);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query(
    `SELECT id, brand_name, status FROM consumer.brands
      WHERE brand_name ILIKE $1 ORDER BY brand_name`,
    [brandName],
  );
  if (rows.length === 0) {
    console.error(`No brand matching "${brandName}".`);
    process.exit(1);
  }

  const totalKg = round1(periods.reduce((s, p) => s + p.totalWasteKg, 0));
  const totalCo2 = round2(periods.reduce((s, p) => s + p.co2AvoidedKg, 0));

  console.log(`brand(s)     ${rows.map((r) => `${r.brand_name} (${r.status})`).join(", ")}`);
  console.log(`buckets      ${periods.length} months, ${periods[0]!.periodStart} to ${periods.at(-1)!.periodEnd}`);
  console.log(`total waste  ${totalKg} kg`);
  console.log(`total CO2    ${totalCo2} kg`);
  console.log(`mode         ${dryRun ? "DRY RUN — nothing written" : "WRITE"}\n`);
  for (const p of periods.slice(-3)) {
    console.log(`  ${p.periodStart}..${p.periodEnd}  ${p.totalWasteKg} kg  ${p.co2AvoidedKg} kg CO2`);
  }

  if (!dryRun) {
    for (const brand of rows) {
      await client.query(
        `UPDATE consumer.brands
            SET environmental_periods = $1::jsonb, updated_at = now()
          WHERE id = $2`,
        [JSON.stringify(periods), brand.id],
      );
      console.log(`\nwrote ${periods.length} buckets to ${brand.brand_name}`);
    }
  } else {
    console.log("\nDry run complete.");
  }
} finally {
  await client.end();
}
