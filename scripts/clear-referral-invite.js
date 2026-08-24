// Clears a referred address out of every user's `referrals` array, making it
// invitable again.
//
// Why this exists: the dedupe in POST /api/users/referrals is global — an
// address held by any user cannot be invited by anyone. Write-after-send
// (issue #144) means a failed send no longer creates such an entry, so the
// common cause of a stuck address is gone. What remains are entries written
// under the old write-before-send order, and legitimate ones whose recipient
// asks to be re-invited after deleting an account. Both need a way out, and
// there was none: no admin route, no script, no detection path.
//
// This is deliberately a CLI and not an API route. It is rare, it is
// destructive, and it needs no client.
//
// Usage:
//   node scripts/clear-referral-invite.js --target=test --email=a@b.com
//   node scripts/clear-referral-invite.js --target=test --email=a@b.com --confirm
//
// Without --confirm the script performs a dry run: it prints which users hold
// the address and writes nothing.

const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();

// The database is chosen explicitly rather than defaulted: --target=production
// reads MONGODB_URI, --target=test reads MONGODB_URI_TEST. There is no
// default, because the failure mode being guarded against is a prod write
// nobody meant to make. Mirrors scripts/backfill-referral-reward-granted.js.
const TARGET = parseTarget();
const EMAIL = parseEmail();
const CONFIRM = process.argv.includes("--confirm");

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
      "--target=production|test is required. Pass --target=test to run " +
        "against MONGODB_URI_TEST, or --target=production to run against " +
        "MONGODB_URI.",
    );
  }
  return value;
}

function parseEmail() {
  const flag = process.argv.find((a) => a.startsWith("--email="));
  const value = flag?.slice("--email=".length).trim().toLowerCase();

  if (!value) {
    throw new Error("--email=<address> is required.");
  }
  // Addresses are stored lowercased and trimmed by the referral route, so the
  // same normalisation is applied here rather than trusting the operator's
  // shell history to have matched the stored casing.
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value)) {
    throw new Error(`--email=${value} does not look like an email address.`);
  }
  return value;
}

// Post-connection assertion, mirroring the database-name guard in the other
// scripts. The URI variable and the database it actually resolves to are
// independent, and this is the one place the real name is observable.
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

  const holders = await users
    .find({ referrals: EMAIL })
    .project({ email: 1 })
    .toArray();

  console.log(`\nUsers holding "${EMAIL}" in referrals: ${holders.length}`);
  holders.forEach((holder) => console.log(`  - ${holder.email}`));

  if (holders.length === 0) {
    console.log(
      "\nNothing to clear — the address is already invitable. If an invite " +
        "still fails, the address belongs to a registered account, which is " +
        "a separate and intentional skip.",
    );
    return;
  }

  if (!CONFIRM) {
    console.log(
      `\nDry run only. ${holders.length} document(s) WOULD have "${EMAIL}" ` +
        `pulled from referrals.` +
        `\nRe-run with --confirm to write:` +
        `\n  node scripts/clear-referral-invite.js --target=${TARGET} ` +
        `--email=${EMAIL} --confirm`,
    );
    return;
  }

  console.log(`\nWriting to "${dbName}" (${TARGET})...`);

  const result = await users.updateMany(
    { referrals: EMAIL },
    { $pull: { referrals: EMAIL } },
  );

  console.log(
    `matchedCount:  ${result.matchedCount}` +
      `\nmodifiedCount: ${result.modifiedCount}`,
  );

  const remaining = await users.countDocuments({ referrals: EMAIL });
  console.log(`Remaining holders: ${remaining}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
