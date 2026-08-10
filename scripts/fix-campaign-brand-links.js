// Repoints each campaign's `brand` ObjectId to its correct, current brand
// document. Campaigns still reference brand _ids from a brand generation that
// no longer exists (deleted during an earlier brand-data migration); the only
// intact link left is the business key `campaign.brandRegistration` ==
// `brand.registrationNumber`. This resolves that string match once and
// rewrites `campaign.brand` to the matching brand's real _id.
//
// Dry-run by default — prints the planned changes without writing anything.
// Pass --apply to actually update the database.

const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();

// This script deliberately CAN write to production — the broken campaign→brand
// links it repairs are in the live data. So the database is chosen explicitly
// rather than defaulted: --target=production reads MONGODB_URI,
// --target=test reads MONGODB_URI_TEST. There is no default, because the
// failure mode being guarded against is a prod write nobody meant to make.
const TARGET = parseTarget();
const MONGODB_URI_KEY =
  TARGET === "production" ? "MONGODB_URI" : "MONGODB_URI_TEST";
const MONGODB_URI = process.env[MONGODB_URI_KEY];

if (!MONGODB_URI) {
  throw new Error(
    `${MONGODB_URI_KEY} is not set — required by --target=${TARGET}. ` +
      "Define it in .env.",
  );
}

function parseTarget() {
  const flag = process.argv.find((a) => a.startsWith("--target="));
  const value = flag?.slice("--target=".length);

  if (value !== "production" && value !== "test") {
    throw new Error(
      "--target=production|test is required. This script can write to the " +
        "primary database, so the target is never inferred: pass " +
        "--target=test to run against MONGODB_URI_TEST, or " +
        "--target=production to run against MONGODB_URI.",
    );
  }
  return value;
}

// Post-connection assertion, mirroring the database-name guard in
// seed-brandhub-demo.js / seed-brandhub-personas.js. The URI variable and the
// database it actually resolves to are independent — a MONGODB_URI_TEST
// pointing at mint_rewards, or a MONGODB_URI pointing at the test database,
// both pass every check upstream of the connection. This is the one place the
// real database name is observable, so the declared target is confirmed here.
function assertDatabaseMatchesTarget(dbName) {
  const looksLikeTest = /(^|[-_])test([-_]|$)|^test_db$/i.test(dbName);

  if (TARGET === "test" && !looksLikeTest) {
    throw new Error(
      `Refusing to run: --target=test but the connected database is ` +
        `"${dbName}", which does not look like a test database.`,
    );
  }
  if (TARGET === "production" && looksLikeTest) {
    throw new Error(
      `Refusing to run: --target=production but the connected database is ` +
        `"${dbName}", which looks like a test database. Check MONGODB_URI.`,
    );
  }
}

const APPLY = process.argv.includes("--apply");

const normalize = (value) => String(value ?? "").trim().toLowerCase();

async function main() {
  await mongoose.connect(MONGODB_URI, { bufferCommands: false });

  try {
    assertDatabaseMatchesTarget(mongoose.connection.db.databaseName);
  } catch (err) {
    await mongoose.disconnect();
    throw err;
  }

  console.log(
    `Target: ${TARGET} (${MONGODB_URI_KEY}) — database ` +
      `"${mongoose.connection.db.databaseName}"${APPLY ? "" : " [dry run]"}`,
  );

  const brands = mongoose.connection.collection("brands");
  const campaigns = mongoose.connection.collection("campaigns");

  const allBrands = await brands.find({}).toArray();
  const brandByRegistration = new Map(
    allBrands
      .filter((b) => normalize(b.registrationNumber))
      .map((b) => [normalize(b.registrationNumber), b]),
  );

  const allCampaigns = await campaigns.find({}).toArray();

  const updates = [];
  const unresolved = [];

  for (const campaign of allCampaigns) {
    const match = brandByRegistration.get(normalize(campaign.brandRegistration));

    if (!match) {
      unresolved.push({
        campaignId: campaign._id.toString(),
        name: campaign.name,
        brandRegistration: campaign.brandRegistration,
      });
      continue;
    }

    if (campaign.brand && campaign.brand.toString() === match._id.toString()) {
      continue; // already correct
    }

    updates.push({
      campaignId: campaign._id,
      name: campaign.name,
      oldBrand: campaign.brand ? campaign.brand.toString() : null,
      newBrand: match._id,
      brandName: match.companyName,
    });
  }

  console.log(`Campaigns needing a brand-link fix: ${updates.length}`);
  for (const u of updates) {
    console.log(
      `  "${u.name}" (${u.campaignId}): ${u.oldBrand} -> ${u.newBrand} (${u.brandName})`,
    );
  }

  if (unresolved.length > 0) {
    console.log(`\nCampaigns with no matching brand (left untouched): ${unresolved.length}`);
    for (const u of unresolved) {
      console.log(`  "${u.name}" (${u.campaignId}): brandRegistration="${u.brandRegistration}"`);
    }
  }

  if (!APPLY) {
    console.log("\nDry run only — pass --apply to write these changes.");
    return;
  }

  for (const u of updates) {
    await campaigns.updateOne(
      { _id: u.campaignId },
      { $set: { brand: u.newBrand } },
    );
  }
  console.log(`\nApplied ${updates.length} update(s).`);
}

main()
  .catch((error) => {
    console.error("Fix failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
