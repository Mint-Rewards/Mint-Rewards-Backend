// Demo-world seed for the BrandHub scoped-routes demo: one org subscribed to
// consumer-reporting (NOT esg), three personas (owner/admin/member), one
// brand, and enough campaign/deal/redemption history that analytics returns
// non-trivial data. Idempotent: re-running resets the demo org to exactly
// this state.
//
// Safety: refuses to run unless the target database is named "test_db",
// in the spirit of the MONGODB_URI_TEST jest guard.

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI_TEST;

if (!MONGODB_URI) {
  throw new Error(
    "MONGODB_URI_TEST is not set — refusing to seed the primary database. " +
      "Define MONGODB_URI_TEST in .env (a separate test database).",
  );
}

const DEMO_ORG_NAME = "Mint Rewards Demo Co";
const DEMO_EMAILS = ["owner@demo.com", "admin@demo.com", "member@demo.com"];
const DEMO_PASSWORD = "password123";
const DEMO_BRAND_NAME = "Mint Demo Brand";

// Modules the demo org subscribes to (all active). Drop an ID from this list
// to demo the locked-tab 402 state for that module — a one-line edit.
const SUBSCRIBED_MODULES = ["consumer-reporting", "esg", "collections", "minttrace"];

const DAY = 24 * 60 * 60 * 1000;

function dateOnly(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  await mongoose.connect(MONGODB_URI, { bufferCommands: false });

  // Belt-and-braces on top of the MONGODB_URI_TEST-only connection above:
  // the database name itself must clearly be a test database ("test_db",
  // "mint-rewards-test", ...), never the production mint_rewards DB.
  const dbName = mongoose.connection.db.databaseName;
  if (!/(^|[-_])test([-_]|$)|^test_db$/i.test(dbName)) {
    await mongoose.disconnect();
    throw new Error(
      `Refusing to seed: connected database is "${dbName}", which does not ` +
        "look like a test database. This script only runs against the " +
        "isolated test database.",
    );
  }

  const organizations = mongoose.connection.collection("organizations");
  const brandusers = mongoose.connection.collection("brandusers");
  const brands = mongoose.connection.collection("brands");
  const campaigns = mongoose.connection.collection("campaigns");
  const deals = mongoose.connection.collection("deals");

  // Reset: remove any prior demo org and everything hanging off it.
  const priorOrgs = await organizations
    .find({ name: DEMO_ORG_NAME })
    .toArray();
  const priorOrgIds = priorOrgs.map((o) => o._id);
  const priorBrands = await brands
    .find({
      $or: [
        { orgId: { $in: priorOrgIds } },
        { brandName: DEMO_BRAND_NAME },
      ],
    })
    .toArray();
  const priorBrandIds = priorBrands.map((b) => b._id);

  await campaigns.deleteMany({ brand: { $in: priorBrandIds } });
  await deals.deleteMany({ brand: { $in: priorBrandIds } });
  await brands.deleteMany({ _id: { $in: priorBrandIds } });
  await brandusers.deleteMany({ email: { $in: DEMO_EMAILS } });
  await organizations.deleteMany({ _id: { $in: priorOrgIds } });

  const now = new Date();

  // 1. Organization — active subscription for every module in
  //    SUBSCRIBED_MODULES (currently all four).
  const { insertedId: orgId } = await organizations.insertOne({
    name: DEMO_ORG_NAME,
    plan: "growth",
    moduleSubscriptions: SUBSCRIBED_MODULES.map((module) => ({
      module,
      status: "active",
      activatedAt: new Date(now.getTime() - 90 * DAY),
      expiresAt: null,
    })),
    createdAt: now,
    updatedAt: now,
  });

  // 2. Three personas.
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  await brandusers.insertMany([
    {
      orgId,
      email: "owner@demo.com",
      passwordHash: hash,
      orgRole: "owner",
      moduleAccess: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      orgId,
      email: "admin@demo.com",
      passwordHash: hash,
      orgRole: "admin",
      moduleAccess: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      orgId,
      email: "member@demo.com",
      passwordHash: hash,
      orgRole: "member",
      // write => can create/edit campaigns and deals, 403 on DELETE (manage).
      // Read-only on collections/esg keeps the dashboard rich while the
      // delete/settings restrictions still demo.
      moduleAccess: [
        { module: "consumer-reporting", permissions: ["write"] },
        { module: "collections", permissions: ["read"] },
        { module: "esg", permissions: ["read"] },
      ],
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // 3. One brand linked to the org, placeholder email/registrationNumber
  //    keyed to its ObjectId per the existing convention.
  const brandId = new mongoose.Types.ObjectId();
  await brands.insertOne({
    _id: brandId,
    orgId,
    brandName: DEMO_BRAND_NAME,
    companyName: DEMO_ORG_NAME,
    email: `brand-${brandId.toString()}@brandhub.local`,
    category: "general",
    description: "Demo brand for the BrandHub scoped-routes walkthrough",
    address: "1 Demo Street",
    webLink: "https://example.com",
    appLink: "",
    contactName: "owner@demo.com",
    phone: "N/A",
    registrationNumber: `BH-${brandId.toString()}`,
    domain: "",
    themeColor: "#3B82F6",
    status: "APPROVED",
    role: "BRAND",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });

  // Fake redeemer user ids, reused across campaigns so uniqueUsers < total
  // redemptions in the analytics summary.
  const redeemers = Array.from(
    { length: 8 },
    () => new mongoose.Types.ObjectId(),
  );

  const campaign = (name, status, startOffsetDays, endOffsetDays, userIdxs, extra = {}) => ({
    name,
    brand: brandId,
    brandRegistration: `BH-${brandId.toString()}`,
    status,
    startDate: dateOnly(new Date(now.getTime() + startOffsetDays * DAY)),
    endDate: dateOnly(new Date(now.getTime() + endOffsetDays * DAY)),
    users: userIdxs.map((i) => redeemers[i]),
    discountCodes: [],
    isSingleCode: false,
    addresses: [],
    description: `${name} — seeded demo campaign`,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });

  // 4a. Campaigns in mixed statuses with redemption history.
  await campaigns.insertMany([
    // Live, APPROVED, heavily redeemed — tops the analytics list.
    campaign("Summer Mint Splash", "APPROVED", -20, 20, [0, 1, 2, 3, 4, 5], {
      campaignType: "seasonal",
      badge: "HOT",
      subtitle: "20% off everything mint",
      backgroundColor: "#DCFCE7",
    }),
    // Live, APPROVED, lighter traffic (overlapping redeemers).
    campaign("Loyalty Double-Up", "APPROVED", -10, 30, [0, 1, 6], {
      campaignType: "loyalty",
    }),
    // APPROVED but already ended — counts toward totals, not "active".
    campaign("Spring Kickoff", "APPROVED", -80, -40, [2, 3, 7], {
      campaignType: "seasonal",
    }),
    // Awaiting moderation — shows the PENDING slice in byStatus.
    campaign("Back To School", "PENDING", 15, 45, []),
    campaign("Weekend Flash Drop", "PENDING", 5, 7, []),
    // Rejected one for a fuller byStatus breakdown.
    campaign("Mystery Box Promo", "REJECTED", -5, 25, []),
  ]);

  // 4b. Deals in mixed statuses.
  const deal = (title, status, extra = {}) => ({
    brand: brandId,
    title,
    description: `${title} — seeded demo deal`,
    discountPercentage: null,
    discountAmount: null,
    promoCode: null,
    startDate: null,
    endDate: null,
    maxUses: null,
    currentUses: 0,
    minimumPurchase: null,
    status,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });

  await deals.insertMany([
    deal("MINT20 storewide", "active", {
      discountPercentage: 20,
      promoCode: "MINT20",
      startDate: dateOnly(new Date(now.getTime() - 15 * DAY)),
      endDate: dateOnly(new Date(now.getTime() + 15 * DAY)),
      maxUses: 500,
      currentUses: 137,
    }),
    deal("Free shipping over $50", "active", {
      discountAmount: 8,
      minimumPurchase: 50,
      currentUses: 42,
    }),
    deal("VIP early access", "inactive", {
      promoCode: "VIPMINT",
      discountPercentage: 30,
    }),
    deal("Last season clearance", "expired", {
      discountPercentage: 50,
      startDate: dateOnly(new Date(now.getTime() - 120 * DAY)),
      endDate: dateOnly(new Date(now.getTime() - 60 * DAY)),
      currentUses: 289,
    }),
  ]);

  console.log(`\nDemo seed complete (db: ${dbName})`);
  console.log("Org ID:  ", orgId.toString());
  console.log("Brand ID:", brandId.toString());
  console.log("Owner:   owner@demo.com  (orgRole: owner — full access to subscribed modules)");
  console.log("Admin:   admin@demo.com  (orgRole: admin — same bypass as owner)");
  console.log("Member:  member@demo.com (consumer-reporting: write, collections: read, esg: read — 403 on DELETE/settings)");
  console.log(`Password: ${DEMO_PASSWORD} for all three`);
  console.log(`Subscriptions (all active): ${SUBSCRIBED_MODULES.join(", ")}`);
  console.log("Content: 6 campaigns (3 APPROVED / 2 PENDING / 1 REJECTED, 12 redemptions, 8 unique users), 4 deals (2 active / 1 inactive / 1 expired)\n");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
