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
        // The real pairing key. `email` still carries the legacy- form for
        // backwards compatibility, but nothing reads it as an identity any
        // more — a brand may freely edit its contact email. See
        // lib/legacyBrandEmail.ts.
        legacyBrandId: doc._id,
        logo: doc.logo || "",
        category: doc.category || "",
        // Carried across from the source rather than left blank: an approved
        // clone supersedes its legacy document in /api/users/active-campaigns,
        // so a placeholder here is what the app would render.
        description: doc.description || "",
        address: doc.address || "",
        webLink: doc.webLink || "https://example.com",
        appLink: doc.appLink || "",
        contactName: doc.contactName || "N/A",
        phone: doc.phone || "0000000000",
        registrationNumber: getLegacyRegistrationNumber(),
        domain: doc.domain || "",
        themeColor,
        // Cloning an APPROVED brand as PENDING hid it from the app until an
        // admin re-approved it (issue #101). Inherit the source's status.
        status: doc.status === "APPROVED" ? "APPROVED" : "PENDING",
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
