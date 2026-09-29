/**
 * Demo data: a brand that has had waste collected from them.
 *
 * Creates the brand's collection account, pins it, and writes a short history
 * of completed rounds so the ESG panel has something true to show.
 *
 *   npm run seed:brand-collections -- --brand "Crumble"
 *   npm run seed:brand-collections -- --brand "Crumble" --reset
 *
 * Raw pg rather than the repositories, like every other script here: Node's
 * type stripping does not resolve the `@/` path aliases. The SQL below writes
 * the same columns setBrandWantsCollections does, and nothing it writes is a
 * demo-only shape — what a demo shows is what a brand will see.
 */
import pg from "pg";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const wanted = flag("brand") ?? "Crumble";
const reset = args.includes("--reset");

// Building precision from a map pin is what makes an account routable;
// anything coarser is a centroid and operations will not send a van to it.
const PIN = { lat: 24.8607, lng: 67.0011 };

/** Rounds to write, oldest first. Weights of the sort a café produces. */
const HISTORY = [
  { daysAgo: 28, kg: 18.4 },
  { daysAgo: 21, kg: 22.1 },
  { daysAgo: 14, kg: 16.75 },
  { daysAgo: 7, kg: 25.3 },
];

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");
const db = new pg.Client({ connectionString: url });
await db.connect();

const { rows: found } = await db.query<{ id: string; brand_name: string }>(
  "SELECT id, brand_name FROM consumer.brands WHERE lower(brand_name) = lower($1) LIMIT 1",
  [wanted],
);
const brand = found[0];
if (!brand) {
  console.error(`No brand named "${wanted}".`);
  process.exit(1);
}
console.log(`brand        ${brand.brand_name} (${brand.id})`);

await db.query(
  "UPDATE consumer.brands SET wants_collections = true WHERE id = $1",
  [brand.id],
);

const { rows: existing } = await db.query<{ id: string }>(
  "SELECT id FROM consumer.users WHERE brand_id = $1 AND account_type = 'BRAND' LIMIT 1",
  [brand.id],
);

let accountId = existing[0]?.id;
if (!accountId) {
  accountId = randomBytes(12).toString("hex");
  await db.query(
    `INSERT INTO consumer.users
       (id, user_name, email, password, mint_id, phone, address,
        email_verified, account_type, brand_id)
     SELECT $1, COALESCE(NULLIF(b.brand_name,''), b.company_name, 'Brand'),
            $2, '', $3, COALESCE(b.phone,''), COALESCE(b.address,''),
            true, 'BRAND', b.id
       FROM consumer.brands b WHERE b.id = $4`,
    [
      accountId,
      `collections+${brand.id}@brands.mintrewards.app`,
      `BRAND-${brand.id.slice(-8).toUpperCase()}`,
      brand.id,
    ],
  );
}
console.log(`account      ${accountId}`);

/*
 * Only pins an account that has none.
 *
 * A brand that dropped its own pin in BrandHub chose that point, and a seed
 * script overwriting it with a constant would move a real premises to wherever
 * this file happens to say. Seeding is for filling gaps, not for asserting.
 *
 * Cast on both uses below: the same parameter feeds a text column and
 * ST_MakePoint, and Postgres will not deduce one type for two.
 */
const pinned = await db.query(
  `UPDATE consumer.users
      SET latitude = $2::text, longitude = $3::text,
          geog = ST_SetSRID(ST_MakePoint($3::float8, $2::float8), 4326)::geography,
          precision = 'building', source = 'map_pin', captured_at = now()
    WHERE id = $1 AND geog IS NULL`,
  [accountId, PIN.lat, PIN.lng],
);
if (pinned.rowCount) {
  console.log(`pinned       ${PIN.lat}, ${PIN.lng} (building / map_pin)`);
} else {
  const { rows: at } = await db.query<{ lat: number; lng: number }>(
    `SELECT ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng
       FROM consumer.users WHERE id = $1`,
    [accountId],
  );
  console.log(
    `pin          kept existing ${at[0]?.lat?.toFixed(5)}, ${at[0]?.lng?.toFixed(5)}`,
  );
}

if (reset) {
  await db.query(
    `DELETE FROM collection_stops s USING collections c
      WHERE s.collection_id = c.id AND c.name LIKE 'Demo:%'`,
  );
  await db.query("DELETE FROM collections WHERE name LIKE 'Demo:%'");
  console.log("reset        removed previous demo rounds");
}

// One zone and one captain for every demo round, named so they are obvious in
// the console and simple to remove.
const { rows: zone } = await db.query<{ id: number }>(
  `INSERT INTO collection_zones (name, city, center, radius_km, signup_threshold, status)
   VALUES ('Demo: Brand pickups', 'Karachi',
           ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)::geography, 5, 1, 'UNLOCKED')
   ON CONFLICT (name, city) DO UPDATE SET radius_km = EXCLUDED.radius_km
   RETURNING id`,
  [PIN.lng, PIN.lat],
);
const { rows: captain } = await db.query<{ id: number }>(
  `INSERT INTO captains (name, phone, email, status)
   VALUES ('Demo Captain', '03001110000', 'demo.captain@mintrewards.app', 'APPROVED')
   ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
   RETURNING id`,
);

let total = 0;
for (const round of HISTORY) {
  const when = new Date(Date.now() - round.daysAgo * 864e5);
  const day = when.toISOString().slice(0, 10);

  const { rows: made } = await db.query<{ id: number }>(
    `INSERT INTO collections
       (name, zone_id, city, scheduled_date, time_slot, captain_id,
        status, completed_at, captain_answer, captain_responded_at)
     VALUES ($1, $2, 'Karachi', $3, 'MORNING', $4, 'COMPLETED', $5, 'ACCEPTED', $5)
     RETURNING id`,
    [
      `Demo: ${brand.brand_name} pickup ${day}`,
      zone[0]!.id,
      day,
      captain[0]!.id,
      when,
    ],
  );

  await db.query(
    `INSERT INTO collection_stops
       (collection_id, user_id, collection_status, address_snapshot,
        location_version_at_assign, status, total_weight_kg, resolved_at)
     VALUES ($1, $2, 'COMPLETED', '{}', 0, 'COLLECTED', $3, $4)`,
    [made[0]!.id, accountId, round.kg, when],
  );

  total += round.kg;
  console.log(`round        ${day}  ${round.kg} kg`);
}

/*
 * The other half of the ESG tab: materials consumers recycled that are linked
 * to this brand.
 *
 * A different measurement from the premises pickups above — that one a
 * captain weighed at their gate, this one attributed from consumer activity —
 * which is why the dashboard shows them as two figures and this script writes
 * them to two places.
 *
 * Written as dated BUCKETS, not one cumulative snapshot. The analytics route
 * sums the buckets overlapping whatever the date picker asked for, so a
 * frozen total would sit unchanged while the picker moved and make the range
 * look broken.
 */
const MATERIALS = [
  { material: "PET plastic", share: 0.42 },
  { material: "Cardboard", share: 0.31 },
  { material: "Aluminium", share: 0.16 },
  { material: "Glass", share: 0.11 },
];

const monthStart = (back: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

const periods = [3, 2, 1, 0].map((back) => {
  const start = monthStart(back);
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  );
  // Rising month on month, so the picker shows a trend rather than a flat line.
  const kg = Math.round((140 + (3 - back) * 55) * 100) / 100;
  return {
    periodStart: iso(start),
    periodEnd: iso(end),
    totalWasteKg: kg,
    co2AvoidedKg: Math.round(kg * 0.21 * 100) / 100,
    materialBreakdown: MATERIALS.map((m) => ({
      material: m.material,
      weightKg: Math.round(kg * m.share * 100) / 100,
    })),
  };
});

const curatedTotal = periods.reduce((a, p) => a + p.totalWasteKg, 0);

await db.query(
  `UPDATE consumer.brands
      SET environmental_periods = $2::jsonb,
          -- The legacy snapshot too: the analytics route prefers buckets and
          -- falls back to this, and a brand read through the older path
          -- should not see nothing.
          environmental_stats = $3::jsonb,
          updated_at = now()
    WHERE id = $1`,
  [
    brand.id,
    JSON.stringify(periods),
    JSON.stringify({
      totalWasteKg: curatedTotal,
      co2AvoidedKg: Math.round(curatedTotal * 0.21 * 100) / 100,
      materialBreakdown: MATERIALS.map((m) => ({
        material: m.material,
        weightKg: Math.round(curatedTotal * m.share * 100) / 100,
      })),
    }),
  ],
);

console.log(
  `\nesg buckets  ${periods.length} months, ${curatedTotal.toFixed(2)} kg attributed`,
);
for (const p of periods) {
  console.log(`  ${p.periodStart} → ${p.periodEnd}  ${p.totalWasteKg} kg`);
}

console.log(`\ntotal        ${total.toFixed(2)} kg`);
console.log(
  `co2 avoided  ${(Math.round(total * 0.21 * 100) / 100).toFixed(2)} kg`,
);
await db.end();
