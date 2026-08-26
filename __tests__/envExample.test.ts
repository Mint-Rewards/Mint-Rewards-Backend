import fs from "fs";
import path from "path";

// lib/env.ts's boot error ends with "See .env.example for the full list of
// required keys." That sentence was a lie until issue #146 item 3 — the file
// did not exist. This suite keeps it honest: a new key added to lib/env.ts
// without a line in .env.example fails here rather than stranding the next
// operator with an error pointing at a file that does not mention it.
describe(".env.example", () => {
  const root = path.join(__dirname, "..");
  const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const envSource = fs.readFileSync(path.join(root, "lib/env.ts"), "utf8");

  // Every string literal handed to one of the env readers in lib/env.ts.
  // Matching on the call sites rather than a hand-kept list is the whole
  // point — a hand-kept list drifts exactly like the missing file did.
  const READER = new RegExp(
    "(?:required|requiredSecret|requiredMatching|requiredAppEnv|" +
      "requiredOriginList|requiredUnlessProduction|optionalHttpsUrl|" +
      "optionalSemver|optionalBuildNumber|optionalBoolean|optionalEnum|" +
      "optionalPositiveInt|optionalBuildNumberOrNull|optionalString|" +
      'optionalIsoDateOrNull)\\(\\s*"([A-Z0-9_]+)"',
    "g",
  );

  const referencedKeys = [
    ...new Set([...envSource.matchAll(READER)].map((m) => m[1])),
  ];

  it("finds the keys lib/env.ts reads", () => {
    // Guards the regex above: a refactor that renames the readers would
    // otherwise silently reduce this suite to asserting nothing.
    expect(referencedKeys.length).toBeGreaterThan(10);
    expect(referencedKeys).toContain("JWT_SECRET");
  });

  it.each(referencedKeys)("documents %s", (key) => {
    // Commented-out lines count: the optional keys are documented as comments
    // on purpose, so that copying the file does not set them.
    expect(example).toMatch(new RegExp(`^#?\\s*${key}=`, "m"));
  });

  it("documents the keys read outside lib/env.ts", () => {
    // MONGODB_URI_TEST is resolved in lib/envShared.ts and required by name in
    // jest.setup.js, so it never appears at a reader call site above.
    expect(example).toMatch(/^#?\s*MONGODB_URI_TEST=/m);
  });
});
