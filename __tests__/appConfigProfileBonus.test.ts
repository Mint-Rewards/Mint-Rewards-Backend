/// <reference types="jest" />

// Marks this file a MODULE rather than a script. Without it, the helpers below
// land in the global scope and collide by name with the identical ones in
// __tests__/appConfigLocationGate.test.ts — which shares this file's technique,
// and therefore its helper names, and which has no top-level import either. Jest
// isolates each file at runtime so the suites still pass, but `tsc --noEmit`
// sees one shared global scope and reports duplicate identifiers.
export {};

// Same isolateModules technique, and the same reason, as
// __tests__/appConfigLocationGate.test.ts: lib/env parses and validates once at
// module load and throws on a problem, so exercising the PROFILE_BONUS_* keys
// under several permutations means giving each case its own module registry.
// A separate file rather than more cases in that one, because the env keys each
// suite must snapshot and clear are disjoint.

const PROFILE_BONUS_KEYS = [
  "PROFILE_BONUS_ENABLED",
  "PROFILE_BONUS_POINTS",
  "PROFILE_BONUS_WINDOW_HOURS",
  "PROFILE_BONUS_CAMPAIGN_START",
  "PROFILE_BONUS_CAMPAIGN_END",
] as const;

type EnvSnapshot = Record<string, string | undefined>;

function snapshotAndClear(): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of PROFILE_BONUS_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  return snapshot;
}

function restore(snapshot: EnvSnapshot): void {
  for (const key of PROFILE_BONUS_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function freshServerEnv(): typeof import("../lib/env").serverEnv {
  let result: typeof import("../lib/env").serverEnv | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    result = require("../lib/env").serverEnv;
  });
  if (!result) throw new Error("isolateModules callback did not run");
  return result;
}

function freshGetAppConfig(): typeof import("../app/api/app-config/route").GET {
  let result: typeof import("../app/api/app-config/route").GET | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    result = require("../app/api/app-config/route").GET;
  });
  if (!result) throw new Error("isolateModules callback did not run");
  return result;
}

describe("profileBonus config", () => {
  let original: EnvSnapshot;

  beforeEach(() => {
    original = snapshotAndClear();
  });

  afterEach(() => {
    restore(original);
  });

  describe("lib/env.ts serverEnv.appConfig.profileBonus", () => {
    it("ships dark: unset env means disabled", () => {
      const serverEnv = freshServerEnv();

      expect(serverEnv.appConfig.profileBonus).toEqual({
        enabled: false,
        points: 100,
        windowHours: 24,
        campaignStart: null,
        campaignEnd: null,
      });
    });

    it("values flow through when set", () => {
      process.env.PROFILE_BONUS_ENABLED = "true";
      process.env.PROFILE_BONUS_POINTS = "250";
      process.env.PROFILE_BONUS_WINDOW_HOURS = "48";
      process.env.PROFILE_BONUS_CAMPAIGN_START = "2026-09-01T00:00:00Z";
      process.env.PROFILE_BONUS_CAMPAIGN_END = "2026-09-30T23:59:59Z";

      const serverEnv = freshServerEnv();

      expect(serverEnv.appConfig.profileBonus).toEqual({
        enabled: true,
        points: 250,
        windowHours: 48,
        campaignStart: "2026-09-01T00:00:00.000Z",
        campaignEnd: "2026-09-30T23:59:59.000Z",
      });
    });

    it("normalises a local-time campaign date to a UTC instant", () => {
      // The operator types whatever their dashboard offers; the wire value is
      // always the same shape.
      process.env.PROFILE_BONUS_CAMPAIGN_START = "2026-09-01T05:00:00+05:00";

      const serverEnv = freshServerEnv();

      expect(serverEnv.appConfig.profileBonus.campaignStart).toBe(
        "2026-09-01T00:00:00.000Z",
      );
    });

    it("fails fast on a malformed campaign date rather than defaulting to null", () => {
      // Silently treating a typo as "unbounded" would run the campaign forever.
      process.env.PROFILE_BONUS_CAMPAIGN_END = "next Tuesday";

      expect(() => freshServerEnv()).toThrow(/PROFILE_BONUS_CAMPAIGN_END/);
    });

    it("fails fast on a non-positive window", () => {
      process.env.PROFILE_BONUS_WINDOW_HOURS = "0";

      expect(() => freshServerEnv()).toThrow(/PROFILE_BONUS_WINDOW_HOURS/);
    });

    it("fails fast on a non-boolean enabled flag", () => {
      process.env.PROFILE_BONUS_ENABLED = "yes";

      expect(() => freshServerEnv()).toThrow(/PROFILE_BONUS_ENABLED/);
    });
  });

  describe("GET /api/app-config", () => {
    it("serves profileBonus without disturbing locationGate", async () => {
      const GET = freshGetAppConfig();
      const body = await (await GET()).json();

      expect(body.profileBonus).toEqual({
        enabled: false,
        points: 100,
        windowHours: 24,
        campaignStart: null,
        campaignEnd: null,
      });
      // The neighbouring block is untouched by this change.
      expect(body.locationGate).toEqual(
        expect.objectContaining({ mode: expect.any(String) }),
      );
    });

    it("reflects configured values in the response", async () => {
      process.env.PROFILE_BONUS_ENABLED = "true";
      process.env.PROFILE_BONUS_CAMPAIGN_END = "2026-09-30T23:59:59Z";

      const GET = freshGetAppConfig();
      const body = await (await GET()).json();

      expect(body.profileBonus).toEqual({
        enabled: true,
        points: 100,
        windowHours: 24,
        campaignStart: null,
        campaignEnd: "2026-09-30T23:59:59.000Z",
      });
    });
  });
});
