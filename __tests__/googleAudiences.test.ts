import {
  LEGACY_GOOGLE_AUDIENCES,
  googleAudiences,
} from "../lib/googleAudiences";

const CURRENT_IOS =
  "78392867949-3jjb4h3kmf5c4bnjun1qg3vitfgtvlqd.apps.googleusercontent.com";
const CURRENT_WEB =
  "78392867949-dsbi2ttj54l3gomb3n112i3itfjt382t.apps.googleusercontent.com";

describe("googleAudiences", () => {
  it("accepts the current iOS and web clients", () => {
    const audiences = googleAudiences(CURRENT_IOS, CURRENT_WEB);

    expect(audiences).toContain(CURRENT_IOS);
    expect(audiences).toContain(CURRENT_WEB);
  });

  it("still accepts tokens from binaries built before the project switch", () => {
    const audiences = googleAudiences(CURRENT_IOS, CURRENT_WEB);

    // Android 2.1.5 (Jul 23) and iOS 2.1.7 build 48 mint against these.
    expect(audiences).toContain(
      "490896222696-4jtrnrbi9uhn98q2ukjb68f2cd45dq2v.apps.googleusercontent.com",
    );
    expect(audiences).toContain(
      "490896222696-3umgevhg0eqtkg03cfs7saa19i0g8qir.apps.googleusercontent.com",
    );
    expect(audiences).toContain(
      "490896222696-kdpgcfnhh860ilahd091n09vnh2f3avs.apps.googleusercontent.com",
    );
  });

  it("puts the current clients ahead of the superseded ones", () => {
    const audiences = googleAudiences(CURRENT_IOS, CURRENT_WEB);

    expect(audiences.slice(0, 2)).toEqual([CURRENT_IOS, CURRENT_WEB]);
  });

  it("does not repeat an entry when a current client is also a legacy one", () => {
    const legacy = LEGACY_GOOGLE_AUDIENCES[0];
    const audiences = googleAudiences(legacy, CURRENT_WEB);

    expect(audiences.filter((a) => a === legacy)).toHaveLength(1);
    expect(new Set(audiences).size).toBe(audiences.length);
  });

  it("lists only well-formed Google client IDs", () => {
    for (const audience of googleAudiences(CURRENT_IOS, CURRENT_WEB)) {
      expect(audience).toMatch(/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
    }
  });
});
