// One-off backfill for the `referralRewardGranted` flag introduced alongside
// lib/referrals.ts.
//
// Why this is needed: referral payouts used to happen inline at signup
// (users/signup/route.ts set `newUser.points = 150` and bumped the referrer by
// 50). That logic is gone; payouts now happen when a user becomes verified,
// guarded by a `referralRewardGranted` flag on the referee.
//
// Every user that existed before this change already had their referral
// resolved under the old rules — but none of them carry the flag. A pre-change
// user who is still unverified and verifies after deploy would therefore be
// paid a SECOND time, and their referrer with them. Setting the flag on every
// existing user closes that window. It is safe precisely because the flag only
// ever suppresses a *future* payout, and no existing user is owed one.
//
// Run order: deploy the new code first, then this script. Running it before
// the deploy is harmless but pointless; running it after the first new signups
// have verified is still safe (they already have the flag set to true).
//
// Usage:
//   node scripts/backfill-referral-reward-granted.js --target=test
//   node scripts/backfill-referral-reward-granted.js --target=test --confirm
//
// Without --confirm the script performs a dry run: it prints how many
// documents WOULD be affected and writes nothing.

const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();

// The database is chosen explicitly rather than defaulted: --target=production
// reads MONGODB_URI, --target=test reads MONGODB_URI_TEST. There is no
// default, because the failure mode being guarded against is a prod write
// nobody meant to make. Mirrors scripts/approve-legacy-clones.js.
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
      "--target=production|test is required. This script performs a bulk " +
        "write over the entire users collection, so the target is never " +
        "inferred: pass --target=test to run against MONGODB_URI_TEST, or " +
        "--target=production to run against MONGODB_URI.",
    );
  }
  return value;
}

// Post-connection assertion, mirroring the database-name guard in
// approve-legacy-clones.js / seed-brandhub-demo.js. The URI variable and the
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

const CONFIRM = process.argv.includes("--confirm");

// Scripts in this directory talk to the raw driver rather than importing
// lib/models.ts — they are CommonJS .js and the models are TypeScript. The
// filter and update below are exactly the UserModel.updateMany this backfill
// is specified as.
const FILTER = { referralRewardGranted: { $ne: true } };
const UPDATE = { $set: { referralRewardGranted: true } };

async function main() {
  await mongoose.connect(MONGODB_URI, { bufferCommands: false });

  const dbName = mongoose.connection.db.databaseName;

  try {
    assertDatabaseMatchesTarget(dbName);
  } catch (err) {
    await mongoose.disconnect();
    throw err;
  }

  console.log(
    `Target: ${TARGET} (${MONGODB_URI_KEY}) — database "${dbName}"` +
      `${CONFIRM ? "" : " [dry run]"}`,
  );

  const users = mongoose.connection.collection("users");

  const total = await users.countDocuments({});
  const affected = await users.countDocuments(FILTER);

  console.log(
    `\nUsers in collection:            ${total}` +
      `\nMissing referralRewardGranted:  ${affected}`,
  );

  if (affected === 0) {
    console.log("\nNothing to backfill — every user already carries the flag.");
    return;
  }

  if (!CONFIRM) {
    console.log(
      `\nDry run only. ${affected} document(s) WOULD be updated with ` +
        `${JSON.stringify(UPDATE)}.` +
        `\nRe-run with --confirm to write:` +
        `\n  node scripts/backfill-referral-reward-granted.js --target=${TARGET} --confirm`,
    );
    return;
  }

  console.log(`\nWriting to "${dbName}" (${TARGET})...`);

  const result = await users.updateMany(FILTER, UPDATE);

  console.log(
    `matchedCount:  ${result.matchedCount}` +
      `\nmodifiedCount: ${result.modifiedCount}`,
  );

  const remaining = await users.countDocuments(FILTER);
  console.log(`Remaining without the flag: ${remaining}`);
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
