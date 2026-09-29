/**
 * Gives the app's brands a BrandHub organisation and an owner who can sign in.
 *
 * The thirty brands that came over from Mongo have `org_id = NULL`. They were
 * never created through BrandHub signup — they arrived through the legacy
 * admin path — so no login reaches them and BrandHub shows them to nobody.
 * This provisions, for each, exactly what `POST /api/brandhub/auth/register`
 * would have: an organisation subscribed to every catalogue module, one
 * `owner` BrandUser, and the brand re-parented onto that organisation.
 *
 * APPROVED only, deliberately: that is the set `/api/users/brands` serves, so
 * it is the set a person sees in the app. The PENDING clones are not shown to
 * anyone and giving them logins would invent structure production never had.
 *
 * Idempotent. A brand that already has an organisation is left alone, and so
 * is an email that already has a login, so a half-finished run is repeated
 * rather than reasoned about.
 *
 *   node --experimental-strip-types scripts/provision-brand-orgs.ts --dry-run
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";

/*
 * Raw SQL rather than the repositories, as every other script here does.
 * `@/lib/...` is a tsconfig path that Next and jest map and bare Node does
 * not, so importing the repository layer fails to resolve before it runs.
 */

/** The catalogue in lib/modules.ts. A new organisation gets all of it. */
const MODULES = ["consumer-reporting", "esg", "minttrace"];

const dryRun = process.argv.includes("--dry-run");
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL must be set.");
  process.exit(1);
}

/**
 * A 24-character ObjectId hex, matching lib/repositories/brandhub.ts.
 *
 * The shape is not cosmetic: findBrandById rejects anything that is not 24
 * hex characters, and BrandHub's JWTs carry orgId.
 */
let counter = randomBytes(3).readUIntBE(0, 3);
const PROCESS_RANDOM = randomBytes(5).toString("hex");
function newObjectId(): string {
  counter = (counter + 1) % 0x1000000;
  return (
    Math.floor(Date.now() / 1000)
      .toString(16)
      .padStart(8, "0") +
    PROCESS_RANDOM +
    counter.toString(16).padStart(6, "0")
  );
}

/**
 * Where the owner's invitation would go.
 *
 * A brand that arrived without an email was given `legacy-<id>@brands.invalid`
 * by the backfill — reserved by RFC 2606 and deliberately unroutable. That is
 * the right value for "this brand has no address" and the wrong one to ask
 * somebody to type, so the login gets a readable name on a domain we own.
 * Where the brand does have a real address, that address is used.
 */
function loginEmail(brandName: string, brandEmail: string): string {
  const given = (brandEmail ?? "").trim().toLowerCase();
  if (given && !given.endsWith("@brands.invalid")) return given;
  const slug = brandName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}@brands.mintrewards.app`;
}

/** Per brand, never shared: one leaked password must not open the other thirteen. */
function newPassword(): string {
  return `${randomBytes(9).toString("base64url")}Aa1!`;
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
const issued: { brand: string; email: string; password: string }[] = [];
const skipped: string[] = [];

try {
  const { rows: approved } = await pool.query(
    `SELECT id, brand_name, company_name, email, org_id
       FROM consumer.brands WHERE status = 'APPROVED' ORDER BY id DESC`,
  );
  const todo = approved.filter((b) => !b.org_id);

  console.log(`APPROVED brands       ${approved.length}`);
  console.log(`already organised     ${approved.length - todo.length}`);
  console.log(`to provision          ${todo.length}`);
  console.log(
    `mode                  ${dryRun ? "DRY RUN — nothing will be written" : "WRITE"}\n`,
  );

  for (const brand of todo) {
    const email = loginEmail(brand.brand_name, brand.email);
    const { rowCount: taken } = await pool.query(
      "SELECT 1 FROM consumer.brand_users WHERE email = $1",
      [email],
    );
    if (taken) {
      skipped.push(`${brand.brand_name} — ${email} already has a login`);
      continue;
    }
    if (dryRun) {
      issued.push({
        brand: brand.brand_name,
        email,
        password: "(not generated)",
      });
      continue;
    }

    const password = newPassword();
    const client = await pool.connect();
    try {
      // All three writes or none: a brand re-parented onto an organisation
      // whose owner was never created is a brand nobody can reach, and is
      // invisible rather than loud.
      await client.query("BEGIN");
      const orgId = newObjectId();
      await client.query(
        `INSERT INTO consumer.organizations (id, name, module_subscriptions)
         VALUES ($1, $2, $3::jsonb)`,
        [
          orgId,
          brand.company_name || brand.brand_name,
          JSON.stringify(
            MODULES.map((m) => ({
              module: m,
              status: "active",
              activatedAt: new Date().toISOString(),
              expiresAt: null,
            })),
          ),
        ],
      );
      await client.query(
        `INSERT INTO consumer.brand_users
           (id, org_id, email, password_hash, org_role, module_access)
         VALUES ($1, $2, $3, $4, 'owner', '[]'::jsonb)`,
        [newObjectId(), orgId, email, await bcrypt.hash(password, 10)],
      );
      await client.query(
        "UPDATE consumer.brands SET org_id = $1, updated_at = now() WHERE id = $2",
        [orgId, brand.id],
      );
      await client.query("COMMIT");
      issued.push({ brand: brand.brand_name, email, password });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  console.table(issued);
  if (skipped.length > 0) console.log(`\nskipped:\n  ${skipped.join("\n  ")}`);
  console.log(
    dryRun
      ? "\nDry run complete. Nothing was written."
      : "\nDone. These passwords are shown once and are not recoverable.",
  );
} finally {
  await pool.end();
}
