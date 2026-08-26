/// <reference types="jest" />

// lib/env.ts parses and validates the environment once, at module load, and
// throws on any problem — so the only way to exercise LOCATION_GATE_* parsing
// under different env permutations (unset / set / invalid) without corrupting
// the serverEnv singleton every other test file already imported is to force
// a fresh module instance per case. jest.isolateModules gives each case its
// own sandboxed module registry, so requiring "../lib/env" inside it re-runs
// the module's top-level parsing (and fail-fast throw) against whatever
// process.env holds at that moment. __tests__/resendWebhook.test.ts solves a
// related problem with jest.mock + property override on the frozen object,
// but that technique can't exercise the throw path this suite needs.

const LOCATION_GATE_KEYS = [
  "LOCATION_GATE_MODE",
  "LOCATION_GATE_ACTIVATED_CITIES_ONLY",
  "LOCATION_GATE_MAX_DISMISSALS",
  "LOCATION_GATE_MIN_BUILD_IOS",
  "LOCATION_GATE_MIN_BUILD_ANDROID",
] as const;

type EnvSnapshot = Record<string, string | undefined>;

function snapshotAndClear(): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of LOCATION_GATE_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  return snapshot;
}

function restore(snapshot: EnvSnapshot): void {
  for (const key of LOCATION_GATE_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Re-requires lib/env fresh, re-running its module-scope parse/throw. */
function freshServerEnv(): typeof import("../lib/env").serverEnv {
  let result: typeof import("../lib/env").serverEnv | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    result = require("../lib/env").serverEnv;
  });
  if (!result) throw new Error("isolateModules callback did not run");
  return result;
}

/** Re-requires the app-config route's GET fresh, alongside a fresh lib/env. */
function freshGetAppConfig(): typeof import("../app/api/app-config/route").GET {
  let result: typeof import("../app/api/app-config/route").GET | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    result = require("../app/api/app-config/route").GET;
  });
  if (!result) throw new Error("isolateModules callback did not run");
  return result;
}

describe("locationGate config (P1.3)", () => {
  let original: EnvSnapshot;

  beforeEach(() => {
    original = snapshotAndClear();
  });

  afterEach(() => {
    restore(original);
  });

  describe("lib/env.ts serverEnv.appConfig.locationGate", () => {
    it("defaults appear when env unset", () => {
      const serverEnv = freshServerEnv();

      expect(serverEnv.appConfig.locationGate).toEqual({
        mode: "soft",
        activatedCitiesOnly: false,
        maxDismissals: 3,
        minClientBuild: { ios: null, android: null },
      });
    });

    it("values flow through when set", () => {
      process.env.LOCATION_GATE_MODE = "hard";
      process.env.LOCATION_GATE_ACTIVATED_CITIES_ONLY = "true";
      process.env.LOCATION_GATE_MAX_DISMISSALS = "7";
      process.env.LOCATION_GATE_MIN_BUILD_IOS = "42";
      process.env.LOCATION_GATE_MIN_BUILD_ANDROID = "43";

      const serverEnv = freshServerEnv();

      expect(serverEnv.appConfig.locationGate).toEqual({
        mode: "hard",
        activatedCitiesOnly: true,
        maxDismissals: 7,
        minClientBuild: { ios: 42, android: 43 },
      });
    });

    it('accepts "off" as a mode', () => {
      process.env.LOCATION_GATE_MODE = "off";

      const serverEnv = freshServerEnv();

      expect(serverEnv.appConfig.locationGate.mode).toBe("off");
    });

    it("fails fast on an invalid LOCATION_GATE_MODE rather than defaulting", () => {
      process.env.LOCATION_GATE_MODE = "bogus";

      expect(() => freshServerEnv()).toThrow(/LOCATION_GATE_MODE/);
    });

    it("fails fast on a non-positive LOCATION_GATE_MAX_DISMISSALS", () => {
      process.env.LOCATION_GATE_MAX_DISMISSALS = "0";

      expect(() => freshServerEnv()).toThrow(/LOCATION_GATE_MAX_DISMISSALS/);
    });

    it("leaves existing appConfig fields untouched", () => {
      const serverEnv = freshServerEnv();

      expect(serverEnv.appConfig).toEqual(
        expect.objectContaining({
          minSupportedVersion: expect.any(String),
          minSupportedBuildNumber: {
            ios: expect.any(Number),
            android: expect.any(Number),
          },
          forceOTA: expect.any(Boolean),
        }),
      );
    });
  });

  describe("GET /api/app-config", () => {
    it("serves locationGate alongside the existing five fields", async () => {
      const GET = freshGetAppConfig();
      const res = await GET();
      const body = await res.json();

      // Existing five fields, byte-identical in shape.
      expect(body).toEqual(
        expect.objectContaining({
          minSupportedVersion: expect.any(String),
          minSupportedBuildNumber: {
            ios: expect.any(Number),
            android: expect.any(Number),
          },
          iosStoreUrl: null,
          androidStoreUrl: null,
          forceOTA: expect.any(Boolean),
        }),
      );

      // New addition, server defaults.
      expect(body.locationGate).toEqual({
        mode: "soft",
        activatedCitiesOnly: false,
        maxDismissals: 3,
        minClientBuild: { ios: null, android: null },
      });
    });

    it("reflects configured locationGate values in the response", async () => {
      process.env.LOCATION_GATE_MODE = "hard";
      process.env.LOCATION_GATE_ACTIVATED_CITIES_ONLY = "true";
      process.env.LOCATION_GATE_MAX_DISMISSALS = "5";
      process.env.LOCATION_GATE_MIN_BUILD_IOS = "10";
      process.env.LOCATION_GATE_MIN_BUILD_ANDROID = "11";

      const GET = freshGetAppConfig();
      const res = await GET();
      const body = await res.json();

      expect(body.locationGate).toEqual({
        mode: "hard",
        activatedCitiesOnly: true,
        maxDismissals: 5,
        minClientBuild: { ios: 10, android: 11 },
      });
    });
  });
});
