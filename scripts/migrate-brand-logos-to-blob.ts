/**
 * Moves brand logos from the old S3 bucket onto Vercel Blob.
 *
 * Nothing in this codebase writes to S3 — `lib/brandLogoUpload.ts` and the
 * register route both `put()` to Blob. Those URLs are inherited from the
 * system that came before, and they are the reason the operations console
 * showed broken images until its CSP was widened to name a bucket we do not
 * own and cannot re-point.
 *
 * Copies rather than trusts: each image is fetched, verified to be an image,
 * uploaded, and only then is the row rewritten — so a bucket that has gone
 * away leaves the old URL in place rather than replacing it with a broken
 * one. The path matches what an upload through BrandHub would produce, so
 * there is no way to tell a migrated logo from a fresh one afterwards.
 *
 * Idempotent: a logo already on Blob is skipped.
 *
 *   node --experimental-strip-types scripts/migrate-brand-logos-to-blob.ts --dry-run
 */
import { put } from "@vercel/blob";
import pg from "pg";

const dryRun = process.argv.includes("--dry-run");
const url = process.env.DATABASE_URL?.trim();
const token = process.env.BLOB_PUBLIC_READ_WRITE_TOKEN?.trim();
if (!url || !token) {
  console.error(
    "DATABASE_URL and BLOB_PUBLIC_READ_WRITE_TOKEN must both be set.",
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
let moved = 0;
const failures: string[] = [];

try {
  const { rows } = await client.query(
    `SELECT id, brand_name, logo FROM consumer.brands
      WHERE logo LIKE '%amazonaws.com%' ORDER BY brand_name`,
  );
  console.log(`logos still on S3   ${rows.length}`);
  console.log(
    `mode                ${dryRun ? "DRY RUN — nothing copied or written" : "WRITE"}\n`,
  );

  for (const brand of rows) {
    const label = brand.brand_name.padEnd(16);
    if (dryRun) {
      console.log(`  ${label} would copy ${brand.logo.split("/").pop()}`);
      continue;
    }
    try {
      const res = await fetch(brand.logo);
      if (!res.ok) throw new Error(`source returned ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        throw new Error(`source is ${contentType || "untyped"}, not an image`);
      }
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0) throw new Error("source is empty");

      const ext = (brand.logo.split(".").pop() ?? "png")
        .toLowerCase()
        .slice(0, 4);
      const blob = await put(
        `brands/${brand.id}/logo-${Date.now()}.${ext}`,
        body,
        {
          access: "public",
          contentType,
          token,
        },
      );
      // Only now: a row rewritten before the upload lands points at nothing.
      await client.query(
        "UPDATE consumer.brands SET logo = $1, updated_at = now() WHERE id = $2",
        [blob.url, brand.id],
      );
      moved += 1;
      console.log(
        `  ${label} ${(body.length / 1024).toFixed(0).padStart(4)}KB -> ${blob.url}`,
      );
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      failures.push(`${brand.brand_name}: ${why}`);
      console.log(`  ${label} LEFT ON S3 — ${why}`);
    }
  }

  console.log(`\nmoved to Blob       ${moved}`);
  if (failures.length > 0)
    console.log(`left alone          ${failures.length}`);
} finally {
  await client.end();
}
