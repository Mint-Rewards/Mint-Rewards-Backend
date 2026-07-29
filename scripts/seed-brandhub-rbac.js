const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("Please set MONGODB_URI in your environment.");
}

const DEMO_ORG_NAME = "Mint Rewards Demo";
const DEMO_EMAILS = ["owner@demo.com", "admin@demo.com", "member@demo.com"];
const DEMO_PASSWORD = "password123";
const DEMO_BRAND_NAMES = [
  "Demo Brand Alpha",
  "Demo Brand Beta",
  "Legacy Orphan Brand",
];

async function main() {
  await mongoose.connect(MONGODB_URI, { bufferCommands: false });

  const organizations = mongoose.connection.collection("organizations");
  const brandusers = mongoose.connection.collection("brandusers");
  const brands = mongoose.connection.collection("brands");

  await organizations.deleteMany({ name: DEMO_ORG_NAME });
  await brandusers.deleteMany({ email: { $in: DEMO_EMAILS } });
  await brands.deleteMany({ brandName: { $in: DEMO_BRAND_NAMES } });

  const now = new Date();
  const { insertedId: orgId } = await organizations.insertOne({
    name: DEMO_ORG_NAME,
    plan: "growth",
    moduleSubscriptions: [
      {
        module: "consumer-reporting",
        status: "active",
        activatedAt: now,
        expiresAt: null,
      },
      // esg deliberately NOT subscribed — even owners hit 402 there.
    ],
    createdAt: now,
    updatedAt: now,
  });

  const demoBrand = (name, suffix, withOrg) => ({
    ...(withOrg ? { orgId } : {}),
    companyName: DEMO_ORG_NAME,
    brandName: name,
    email: `demo-brand-${suffix}@brandhub.local`,
    category: "general",
    description: "",
    address: "",
    webLink: "https://example.com",
    appLink: "",
    contactName: "Demo Contact",
    phone: "N/A",
    registrationNumber: `DEMO-${suffix}`,
    domain: "",
    themeColor: "#3B82F6",
    status: "APPROVED",
    role: "BRAND",
    emailVerified: true,
  });

  const { insertedIds: brandIds } = await brands.insertMany([
    demoBrand("Demo Brand Alpha", "alpha", true),
    demoBrand("Demo Brand Beta", "beta", true),
    // Legacy brand with NO orgId — verifies the 404-on-unowned-brand path
    demoBrand("Legacy Orphan Brand", "orphan", false),
  ]);

  const hash = (pw) => bcrypt.hash(pw, 10);

  await brandusers.insertMany([
    {
      orgId,
      email: "owner@demo.com",
      passwordHash: await hash(DEMO_PASSWORD),
      orgRole: "owner",
      moduleAccess: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      orgId,
      email: "admin@demo.com",
      passwordHash: await hash(DEMO_PASSWORD),
      orgRole: "admin",
      moduleAccess: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      orgId,
      email: "member@demo.com",
      passwordHash: await hash(DEMO_PASSWORD),
      orgRole: "member",
      moduleAccess: [{ module: "consumer-reporting", permissions: ["write"] }],
      createdAt: now,
      updatedAt: now,
    },
  ]);

  console.log("\nSeed complete");
  console.log("Org ID:  ", orgId.toString());
  console.log("Owner:   owner@demo.com  (orgRole: owner — all subscribed modules, full access)");
  console.log("Admin:   admin@demo.com  (orgRole: admin — all subscribed modules, full access)");
  console.log("Member:  member@demo.com (consumer-reporting:write)");
  console.log(`\nTest credentials: ${DEMO_PASSWORD} for all three accounts`);
  console.log("\nSubscriptions: consumer-reporting active, esg never subscribed (402 expected)");
  console.log("\nBrand IDs:");
  console.log("  Alpha (org-owned): ", brandIds[0].toString());
  console.log("  Beta  (org-owned): ", brandIds[1].toString());
  console.log("  Orphan (no orgId): ", brandIds[2].toString(), "— 404 expected via brandhub\n");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
