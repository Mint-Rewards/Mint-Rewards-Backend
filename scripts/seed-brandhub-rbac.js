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

async function main() {
  await mongoose.connect(MONGODB_URI, { bufferCommands: false });

  const organizations = mongoose.connection.collection("organizations");
  const brandusers = mongoose.connection.collection("brandusers");

  await organizations.deleteMany({ name: DEMO_ORG_NAME });
  await brandusers.deleteMany({ email: { $in: DEMO_EMAILS } });

  const now = new Date();
  const { insertedId: orgId } = await organizations.insertOne({
    name: DEMO_ORG_NAME,
    plan: "growth",
    subscribedModules: ["b2c", "analytics", "settings"],
    createdAt: now,
    updatedAt: now,
  });

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
      moduleAccess: [
        { module: "b2c", permissions: ["write"] },
        { module: "analytics", permissions: ["read"] },
      ],
      createdAt: now,
      updatedAt: now,
    },
  ]);

  console.log("\nSeed complete");
  console.log("Org ID:  ", orgId.toString());
  console.log("Owner:   owner@demo.com  (orgRole: owner — all subscribed modules, full access)");
  console.log("Admin:   admin@demo.com  (orgRole: admin — all subscribed modules, full access)");
  console.log("Member:  member@demo.com (b2c:write, analytics:read)");
  console.log(`\nTest credentials: ${DEMO_PASSWORD} for all three accounts`);
  console.log("Note: b2b and minttrace are NOT subscribed — 402 expected for those modules\n");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
