// Reconciles the brand documents cloned from legacy brands by
// scripts/clone-legacy-brands.js. Three things, in one pass:
//
//   1. Backfills `legacyBrandId` from the `legacy-<24hex>@example.com` email
//      the pairing used to be encoded in. /api/users/active-campaigns now reads
//      the indexed field instead of parsing the email, so a brand can correct
//      its contact email without unjoining its campaigns (issue #98).
//
//   2. Sets `status: "APPROVED"` on clones whose source document is itself
//      APPROVED. The clone script inserted every clone as PENDING, so brands
//      that predate the APPROVED-only filter in active-campaigns are hidden
//      from the app until an admin re-approves them (issue #101).
//
//   3. Backfills description/address/webLink/contactName/phone/domain from the
//      source. The clone script wrote placeholders ("N/A", "0000000000",
//      "https://example.com", ""), and an approved clone SUPERSEDES its legacy
//      document in the listing — so approving without this would replace real
//      brand data with the placeholders in the app.
//
// Two effects worth knowing before running with --apply:
//   - Approving a clone flips which `_id` the app sees for that brand, because
//     the clone supersedes the legacy document it was made from.
//   - Clones carry no `orgId`, so requireBrandScope still blocks the brand from
//     editing its own record in BrandHub. Attaching orgId is out of scope here.
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

const LEGACY_EMAIL_RE = /^legacy-([0-9a-f]{24})@example\.com$/i;

// Placeholder values clone-legacy-brands.js wrote when it had nothing to copy.
// A field is only backfilled when it currently holds one of these, so a clone
// a brand has since edited by hand is never overwritten.
const PLACEHOLDERS = {
  description: ["", null, undefined],
  address: ["", null, undefined],
  webLink: ["", null, undefined, "https://example.com"],
  appLink: ["", null, undefined],
  contactName: ["", null, undefined, "N/A"],
  phone: ["", null, undefined, "0000000000"],
  domain: ["", null, undefined],
};

const isPlaceholder = (field, value) => PLACEHOLDERS[field].includes(value);

async function main() {
  await mongoose.connect(MONGODB_URI, { bufferCommands: false });

  const brands = mongoose.connection.collection("brands");

  const allBrands = await brands.find({}).toArray();
  const brandById = new Map(allBrands.map((b) => [b._id.toString(), b]));

  // A clone is anything already carrying legacyBrandId, or anything whose
  // email still has the legacy- form (i.e. not yet migrated).
  const clones = allBrands
    .map((clone) => {
      if (clone.legacyBrandId) {
        return { clone, legacyId: clone.legacyBrandId.toString() };
      }
      const match = LEGACY_EMAIL_RE.exec(String(clone.email ?? ""));
      return match ? { clone, legacyId: match[1] } : null;
    })
    .filter(Boolean);

  const updates = [];
  const orphans = [];

  for (const { clone, legacyId } of clones) {
    const source = brandById.get(legacyId);

    if (!source) {
      orphans.push({ cloneId: clone._id.toString(), legacyId, name: clone.companyName });
      continue;
    }

    const set = {};

    if (!clone.legacyBrandId) {
      set.legacyBrandId = source._id;
    }

    // Only promote a clone whose source is itself approved. A clone of a
    // pending or rejected brand stays hidden, as it should.
    if (source.status === "APPROVED" && clone.status !== "APPROVED") {
      set.status = "APPROVED";
    }

    for (const field of Object.keys(PLACEHOLDERS)) {
      const sourceValue = source[field];
      if (
        isPlaceholder(field, clone[field]) &&
        sourceValue &&
        !isPlaceholder(field, sourceValue)
      ) {
        set[field] = sourceValue;
      }
    }

    if (Object.keys(set).length === 0) continue;

    updates.push({
      cloneId: clone._id,
      name: clone.companyName,
      legacyId,
      sourceStatus: source.status,
      set,
    });
  }

  console.log(`Legacy clones found: ${clones.length}`);
  console.log(`Clones needing changes: ${updates.length}\n`);

  for (const u of updates) {
    console.log(`  "${u.name}" (${u.cloneId}) <- legacy ${u.legacyId} [${u.sourceStatus}]`);
    for (const [field, value] of Object.entries(u.set)) {
      console.log(`      ${field}: ${JSON.stringify(value)}`);
    }
  }

  if (orphans.length > 0) {
    console.log(`\nClones whose source document is missing (left untouched): ${orphans.length}`);
    for (const o of orphans) {
      console.log(`  "${o.name}" (${o.cloneId}): legacyBrandId=${o.legacyId}`);
    }
  }

  const approvals = updates.filter((u) => u.set.status === "APPROVED").length;
  if (approvals > 0) {
    console.log(
      `\nNOTE: ${approvals} clone(s) will become APPROVED and supersede their legacy ` +
        `document in /api/users/active-campaigns. The brand _id the app sees changes ` +
        `for each of them.`,
    );
  }

  if (!APPLY) {
    console.log("\nDry run only — pass --apply to write these changes.");
    return;
  }

  for (const u of updates) {
    await brands.updateOne({ _id: u.cloneId }, { $set: u.set });
  }
  console.log(`\nApplied ${updates.length} update(s).`);
}

main()
  .catch((error) => {
    console.error("Reconcile failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
