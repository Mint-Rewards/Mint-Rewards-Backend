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

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("Please set MONGODB_URI in your environment.");
}

const APPLY = process.argv.includes("--apply");

const normalize = (value) => String(value ?? "").trim().toLowerCase();

async function main() {
  await mongoose.connect(MONGODB_URI, { bufferCommands: false });

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
