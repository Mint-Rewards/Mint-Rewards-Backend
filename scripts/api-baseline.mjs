#!/usr/bin/env node
/**
 * Compare two API baselines recorded by `scripts/test-api.mjs --record`.
 *
 * Usage:
 *   node scripts/api-baseline.mjs compare <baseline.json> <candidate.json>
 *   node scripts/api-baseline.mjs compare <a> <b> --full     # every diff, not just the first few
 *   node scripts/api-baseline.mjs rules                      # print the normalization rules
 *
 * Exits non-zero if anything differs, so it can gate CI or a cutover.
 *
 * Read scripts/lib/api-baseline.js for what "differs" means — in particular
 * that ids are compared as stable symbols (so a reference pointing at the
 * WRONG row fails) and that array order is deliberately never sorted.
 */

import { readFileSync } from "fs";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const { compareCaptures, summarize } = require_("./lib/api-baseline.js");

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

const [, , cmd, ...rest] = process.argv;

if (cmd === "rules") {
  const src = readFileSync(
    new URL("./lib/api-baseline.js", import.meta.url),
    "utf8",
  );
  const doc = src.slice(0, src.indexOf("*/") + 2);
  console.log(doc);
  process.exit(0);
}

if (cmd !== "compare" || rest.filter((a) => !a.startsWith("--")).length !== 2) {
  console.error(
    "Usage:\n" +
      "  node scripts/api-baseline.mjs compare <baseline.json> <candidate.json> [--full]\n" +
      "  node scripts/api-baseline.mjs rules",
  );
  process.exit(1);
}

const FULL = rest.includes("--full");
const [baselinePath, candidatePath] = rest.filter((a) => !a.startsWith("--"));

const load = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`Could not read ${p}: ${err.message}`);
    process.exit(1);
  }
};

const baseline = load(baselinePath);
const candidate = load(candidatePath);

console.log(`${BOLD}API baseline comparison${RESET}`);
console.log(
  `${DIM}baseline : ${baselinePath}  (${baseline.target}, ${baseline.recordedAt})${RESET}`,
);
console.log(
  `${DIM}candidate: ${candidatePath}  (${candidate.target}, ${candidate.recordedAt})${RESET}\n`,
);

const results = compareCaptures(baseline, candidate);
const counts = summarize(results);

const MAX_DIFFS_SHOWN = 8;
for (const r of results) {
  if (r.kind === "match") continue;
  const colour = r.kind === "differs" ? RED : YELLOW;
  console.log(`${colour}${r.kind.toUpperCase()}${RESET}  ${r.label}`);
  const shown = FULL ? r.diffs : r.diffs.slice(0, MAX_DIFFS_SHOWN);
  for (const d of shown) {
    console.log(
      `    ${d.path}\n      baseline : ${JSON.stringify(d.baseline)}\n      candidate: ${JSON.stringify(d.current)}`,
    );
  }
  if (!FULL && r.diffs.length > MAX_DIFFS_SHOWN) {
    console.log(
      `    ${DIM}...and ${r.diffs.length - MAX_DIFFS_SHOWN} more (pass --full)${RESET}`,
    );
  }
  console.log("");
}

console.log("─".repeat(56));
console.log(
  `${BOLD}Results:${RESET}  ${GREEN}${counts.match} match${RESET}  ` +
    `${RED}${counts.differs} differ${RESET}  ` +
    `${YELLOW}${counts.missing} missing  ${counts.extra} extra  ${counts.desynced} desynced${RESET}`,
);

// "desynced" means the two runs issued different requests at the same index —
// usually a test-api.mjs change between captures, not a backend difference.
if (counts.desynced > 0) {
  console.log(
    `\n${YELLOW}Note:${RESET} desynced entries mean the two runs issued different requests.\n` +
      `That is a change in test-api.mjs itself, not a backend parity finding —\n` +
      `re-record the baseline against the same runner before reading the rest.`,
  );
}

const bad = counts.differs + counts.missing + counts.extra + counts.desynced;
process.exit(bad > 0 ? 1 : 0);
