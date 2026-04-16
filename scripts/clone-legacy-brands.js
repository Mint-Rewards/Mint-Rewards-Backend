const mongoose = require("mongoose");
const { randomUUID } = require("crypto");
const dotenv = require("dotenv");

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("Please set MONGODB_URI in your environment.");
}

function getLegacyEmail(sourceId) {
  return `legacy-${sourceId}@example.com`;
}

function getLegacyRegistrationNumber() {
  return randomUUID();
}

async function main() {
  await mongoose.connect(MONGODB_URI, { bufferCommands: false });

  const brands = mongoose.connection.collection("brands");

  const legacyDocs = await brands
    .find({
      status: "APPROVED",
    })
    .toArray();

  if (legacyDocs.length === 0) {
    console.log("No legacy brand docs found.");
    return;
  }

  const legacyEmails = legacyDocs.map((doc) => getLegacyEmail(doc._id));
  const existing = await brands
    .find({ email: { $in: legacyEmails } }, { projection: { email: 1 } })
    .toArray();
  const existingEmails = new Set(existing.map((doc) => doc.email));

  const inserts = legacyDocs
    .filter((doc) => !existingEmails.has(getLegacyEmail(doc._id)))
    .map((doc) => {
      const name = typeof doc.name === "string" ? doc.name.trim() : "";
      const themeColor =
        (typeof doc.accentColor === "string" && doc.accentColor.trim()) ||
        (typeof doc.backgroundColor === "string" &&
          doc.backgroundColor.trim()) ||
        "#3B82F6";

      return {
        companyName: name || "Unknown",
        brandName: name || "Unknown",
        email: getLegacyEmail(doc._id),
        logo: doc.logo || "",
        category: doc.category || "",
        description: "",
        address: "",
        webLink: "https://example.com",
        appLink: "",
        contactName: "N/A",
        phone: "0000000000",
        registrationNumber: getLegacyRegistrationNumber(),
        domain: "",
        themeColor,
        status: "PENDING",
        role: "BRAND",
        emailVerified: false,
        verificationToken: null,
      };
    });

  if (inserts.length === 0) {
    console.log("No new legacy brands to insert.");
    return;
  }

  const result = await brands.insertMany(inserts);
  console.log(`Inserted ${result.insertedCount} brand documents.`);
}

main()
  .catch((error) => {
    console.error("Clone failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
