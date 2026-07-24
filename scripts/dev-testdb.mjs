#!/usr/bin/env node
/**
 * Starts `next dev` with MONGODB_URI pointed at MONGODB_URI_TEST, so the
 * local API test runner (scripts/test-api.mjs --local) exercises the
 * isolated test database instead of production.
 *
 * Usage: npm run dev:testdb
 */
import { spawn } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });

const testUri = process.env.MONGODB_URI_TEST;
if (!testUri) {
  console.error(
    "MONGODB_URI_TEST is not set — refusing to start against the primary database.\n" +
      "Define MONGODB_URI_TEST in .env (a separate test database).",
  );
  process.exit(1);
}

console.log("Starting next dev against the TEST database (MONGODB_URI_TEST).");

const child = spawn("npx", ["next", "dev"], {
  stdio: "inherit",
  env: { ...process.env, MONGODB_URI: testUri },
});

child.on("exit", (code) => process.exit(code ?? 0));
