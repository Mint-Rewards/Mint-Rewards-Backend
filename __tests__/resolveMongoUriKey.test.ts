import { resolveMongoUriKey } from "@/lib/envShared";

// Local `next dev` used to run against whatever MONGODB_URI held, which in
// practice was the production mint_rewards database — APP_ENV=development
// changed mail routing but never the database. These cases pin the rule that
// a development boot prefers the isolated test database when one is defined.
describe("resolveMongoUriKey", () => {
  it("prefers MONGODB_URI_TEST in development", () => {
    expect(
      resolveMongoUriKey("development", "mongodb+srv://host/mint-rewards-test"),
    ).toBe("MONGODB_URI_TEST");
  });

  it("falls back to MONGODB_URI in development when no test URI is defined", () => {
    // The deployed dev backend (Vercel Preview, branch dev) sets only
    // MONGODB_URI — already pointed at the test database. Requiring
    // MONGODB_URI_TEST there would take that deployment down at boot.
    expect(resolveMongoUriKey("development", undefined)).toBe("MONGODB_URI");
  });

  it("treats a blank MONGODB_URI_TEST as unset", () => {
    expect(resolveMongoUriKey("development", "   ")).toBe("MONGODB_URI");
  });

  it("ignores MONGODB_URI_TEST in production", () => {
    // A stray MONGODB_URI_TEST in the production environment must never be
    // able to redirect production traffic to the test database.
    expect(
      resolveMongoUriKey("production", "mongodb+srv://host/mint-rewards-test"),
    ).toBe("MONGODB_URI");
  });
});
