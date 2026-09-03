/**
 * Unit tests for the API baseline normalizer (scripts/lib/api-baseline.js).
 *
 * The normalizer is the load-bearing half of the Mongo -> Postgres parity
 * check: it decides what counts as a real response difference and what is
 * run-to-run noise. Getting it wrong in either direction defeats the whole
 * exercise — too aggressive and a genuine migration bug is normalized away,
 * too timid and every diff is drowned in ids and timestamps. So each rule in
 * that file's header has a test here.
 *
 * scripts/lib/api-baseline.js is plain CommonJS (this repo's scripts are —
 * see scripts/location-backfill-audit.js for the same pattern);
 * `esModuleInterop` + `allowJs` let it be imported like any other module.
 */
import {
  createSymbolTable,
  normalizeValue,
  normalizeCapture,
  normalizePath,
  compareCaptures,
  summarize,
} from "../scripts/lib/api-baseline.js";

const OID_A = "6a5e072f9585b6b2f80957d0";

const norm = (value: unknown, key = "") =>
  normalizeValue(value, createSymbolTable(), key);

describe("rule 1 — identifiers become stable symbols, not blanks", () => {
  it("maps a Mongo ObjectId and a Postgres integer to the same symbol shape", () => {
    const mongo = normalizeCapture([
      { method: "GET", path: "/brands", status: 200, data: { id: OID_A } },
    ]);
    const postgres = normalizeCapture([
      { method: "GET", path: "/brands", status: 200, data: { id: 42 } },
    ]);
    expect(mongo.interactions[0].data).toEqual({ id: "<id:1>" });
    // The whole point: two different representations normalize identically, so
    // a migration that preserves structure passes.
    expect(postgres.interactions[0].data).toEqual(mongo.interactions[0].data);
  });

  it("preserves referential structure ACROSS responses", () => {
    // A deal pointing at a brand: same value in both responses must stay the
    // same symbol, in both the Mongo and the Postgres representation.
    const mongo = normalizeCapture([
      { method: "GET", path: "/brands", status: 200, data: { id: OID_A } },
      { method: "GET", path: "/deals", status: 200, data: { brandId: OID_A } },
    ]);
    expect(mongo.interactions[0].data).toEqual({ id: "<id:1>" });
    expect(mongo.interactions[1].data).toEqual({ brandId: "<id:1>" });
  });

  it("FAILS when a reference points at the wrong row — the bug this exists to catch", () => {
    const good = normalizeCapture([
      { method: "GET", path: "/b", status: 200, data: { id: OID_A } },
      { method: "GET", path: "/d", status: 200, data: { brandId: OID_A } },
    ]);
    // Postgres run where the deal got cross-linked to a DIFFERENT brand.
    const bad = normalizeCapture([
      { method: "GET", path: "/b", status: 200, data: { id: 1 } },
      { method: "GET", path: "/d", status: 200, data: { brandId: 2 } },
    ]);
    const results = compareCaptures(good, bad);
    expect(summarize(results).differs).toBe(1);
    expect(results[1].diffs[0]).toMatchObject({
      path: "data.brandId",
      baseline: "<id:1>",
      current: "<id:2>",
    });
  });

  it("symbolizes ids embedded in the URL path", () => {
    const symbols = createSymbolTable();
    expect(normalizePath(`/brands/${OID_A}/deals`, symbols)).toBe(
      "/brands/<id:1>/deals",
    );
    // Same id later in the run keeps the same symbol.
    expect(normalizePath(`/brands/${OID_A}`, symbols)).toBe("/brands/<id:1>");
    expect(normalizePath("/brands/42/deals", symbols)).toBe(
      "/brands/<id:2>/deals",
    );
  });

  it("symbolizes an ObjectId found under a key nobody enumerated", () => {
    // The safety net: unknown key, but the VALUE is unmistakably an ObjectId.
    expect(norm({ someUnlistedRef: OID_A })).toEqual({
      someUnlistedRef: "<id:1>",
    });
  });

  it("does not symbolize ordinary integers under non-id keys", () => {
    // `points` and `weight` are data, not references.
    expect(norm({ points: 250, weight: 3 })).toEqual({
      points: 250,
      weight: 3,
    });
  });
});

describe("rule 2 — secrets become <token>", () => {
  it("blanks token fields but preserves presence", () => {
    expect(norm({ token: "eyJhbGciOi.abc.def" })).toEqual({ token: "<token>" });
    expect(norm({ password: "hunter2" })).toEqual({ password: "<token>" });
  });

  it("blanks a bare JWT even under an unexpected key", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(norm({ weirdField: jwt })).toEqual({ weirdField: "<token>" });
  });

  it("distinguishes a null token from a present one", () => {
    // Presence is the comparable property — null must not become "<token>".
    expect(norm({ token: null })).toEqual({ token: null });
  });
});

describe("rule 3 — server-stamped dates blanked, domain dates KEPT", () => {
  it("blanks createdAt/updatedAt", () => {
    expect(norm({ createdAt: "2026-09-02T10:00:00.000Z" })).toEqual({
      createdAt: "<timestamp>",
    });
  });

  it("keeps startDate/endDate, which are data", () => {
    // This schema carries every campaign/deal date as `text` (known type debt),
    // so a migration mangling them MUST fail the diff.
    const dates = { startDate: "2026-01-01", endDate: "2026-03-31" };
    expect(norm(dates)).toEqual(dates);
  });

  it("catches a domain date that the migration mangled", () => {
    const a = normalizeCapture([
      {
        method: "GET",
        path: "/c",
        status: 200,
        data: { startDate: "2026-01-01" },
      },
    ]);
    const b = normalizeCapture([
      {
        method: "GET",
        path: "/c",
        status: 200,
        data: { startDate: "2026-01-01T00:00:00.000Z" },
      },
    ]);
    expect(summarize(compareCaptures(a, b)).differs).toBe(1);
  });
});

describe("rule 4 — per-run generated identity is stripped, stable part kept", () => {
  it("strips the Date.now()+uuid suffix from an email", () => {
    const out = norm({
      email: "qa-user-1756800000000a1b2c3d4@example.com",
    }) as {
      email: string;
    };
    expect(out.email).toBe("qa-user-<generated>@example.com");
  });

  it("keeps the stable part, so a real change still shows up", () => {
    const a = norm({ email: "qa-user-1756800000000a1b2c3d4@example.com" });
    const b = norm({ email: "different-1756800000000a1b2c3d4@example.com" });
    expect(a).not.toEqual(b);
  });

  it("strips the suffix when it is echoed inside a message string", () => {
    const out = norm({
      message: "User qa-1756800000000a1b2c3d4 created",
    }) as { message: string };
    expect(out.message).toBe("User qa-<generated> created");
  });
});

describe("rule 5 — array order is preserved, never sorted", () => {
  it("reports a reordered list as a difference", () => {
    const a = normalizeCapture([
      {
        method: "GET",
        path: "/deals",
        status: 200,
        data: { deals: ["x", "y"] },
      },
    ]);
    const b = normalizeCapture([
      {
        method: "GET",
        path: "/deals",
        status: 200,
        data: { deals: ["y", "x"] },
      },
    ]);
    // Sorting here would be the tempting bug: it would hide a real ordering
    // change that the app may render directly.
    expect(summarize(compareCaptures(a, b)).differs).toBe(1);
  });
});

describe("rule 6 — absent, null and empty stay distinct", () => {
  it("normalizes key ORDER without collapsing key presence", () => {
    expect(JSON.stringify(norm({ b: 1, a: 2 }))).toBe(
      JSON.stringify({ a: 2, b: 1 }),
    );
  });

  it("reports absent vs null vs empty string as three different things", () => {
    const cap = (data: unknown) =>
      normalizeCapture([{ method: "GET", path: "/u", status: 200, data }]);
    // This is the exact seam that produced a real ETL bug (explicit null
    // defeating a NOT NULL DEFAULT) — it must remain visible at the API layer.
    expect(
      summarize(compareCaptures(cap({}), cap({ latitude: null }))).differs,
    ).toBe(1);
    expect(
      summarize(compareCaptures(cap({ latitude: null }), cap({ latitude: "" })))
        .differs,
    ).toBe(1);
  });
});

describe("comparison mechanics", () => {
  const one = (data: unknown, status = 200) =>
    normalizeCapture([{ method: "GET", path: "/x", status, data }]);

  it("reports identical captures as a clean match", () => {
    const r = compareCaptures(one({ a: 1 }), one({ a: 1 }));
    expect(summarize(r)).toMatchObject({ match: 1, differs: 0 });
  });

  it("catches a changed status code", () => {
    const r = compareCaptures(one({ a: 1 }, 200), one({ a: 1 }, 500));
    expect(r[0].diffs).toContainEqual({
      path: "status",
      baseline: 200,
      current: 500,
    });
  });

  it("reports array length changes explicitly", () => {
    const r = compareCaptures(one({ xs: [1, 2, 3] }), one({ xs: [1, 2] }));
    expect(r[0].diffs).toContainEqual({
      path: "data.xs.length",
      baseline: 3,
      current: 2,
    });
  });

  it("flags desynced runs rather than silently shifting comparisons", () => {
    const a = normalizeCapture([
      { method: "GET", path: "/a", status: 200, data: {} },
    ]);
    const b = normalizeCapture([
      { method: "GET", path: "/b", status: 200, data: {} },
    ]);
    expect(summarize(compareCaptures(a, b)).desynced).toBe(1);
  });

  it("reports missing and extra interactions", () => {
    const a = normalizeCapture([
      { method: "GET", path: "/a", status: 200, data: {} },
      { method: "GET", path: "/b", status: 200, data: {} },
    ]);
    const b = normalizeCapture([
      { method: "GET", path: "/a", status: 200, data: {} },
    ]);
    expect(summarize(compareCaptures(a, b)).missing).toBe(1);
    expect(summarize(compareCaptures(b, a)).extra).toBe(1);
  });
});

describe("regressions found by recording real backend responses", () => {
  it("redacts confirmPassword, not just password", () => {
    // Found live: a real /users/signup capture wrote confirmPassword in the
    // clear. Baselines are committed and shared, so this is a leak, not noise.
    expect(norm({ password: "p", confirmPassword: "p" })).toEqual({
      password: "<token>",
      confirmPassword: "<token>",
    });
  });

  it("redacts password-reset aliases", () => {
    expect(
      norm({ newPassword: "x", oldPassword: "y", currentPassword: "z" }),
    ).toEqual({
      newPassword: "<token>",
      oldPassword: "<token>",
      currentPassword: "<token>",
    });
  });

  it("symbolizes mintId so a per-run value is not permanent diff noise", () => {
    // Two runs mint different mintIds for the equivalent user; both must
    // normalize to the same symbol, and stay consistent across responses.
    const runA = normalizeCapture([
      {
        method: "POST",
        path: "/signup",
        status: 200,
        data: { mintId: "30941521" },
      },
      { method: "GET", path: "/me", status: 200, data: { mintId: "30941521" } },
    ]);
    const runB = normalizeCapture([
      {
        method: "POST",
        path: "/signup",
        status: 200,
        data: { mintId: "88817364" },
      },
      { method: "GET", path: "/me", status: 200, data: { mintId: "88817364" } },
    ]);
    expect(summarize(compareCaptures(runA, runB)).differs).toBe(0);
  });

  it("still catches a mintId that changes between responses within one run", () => {
    // Consistency is the property under test — a user whose mintId changes
    // mid-run is a real bug and must survive normalization.
    const consistent = normalizeCapture([
      {
        method: "POST",
        path: "/signup",
        status: 200,
        data: { mintId: "30941521" },
      },
      { method: "GET", path: "/me", status: 200, data: { mintId: "30941521" } },
    ]);
    const drifting = normalizeCapture([
      {
        method: "POST",
        path: "/signup",
        status: 200,
        data: { mintId: "30941521" },
      },
      { method: "GET", path: "/me", status: 200, data: { mintId: "99999999" } },
    ]);
    expect(summarize(compareCaptures(consistent, drifting)).differs).toBe(1);
  });
});

describe("hardening from scanning a real 141-interaction capture", () => {
  it("redacts reset and social-auth tokens by NAME, not by shape", () => {
    // A password-reset token need not be JWT-shaped, so the JWT regex would
    // miss it; a real Google/Apple idToken is a live credential.
    expect(
      norm({
        resetToken: "a1b2c3d4e5f6a1b2c3d4e5f6",
        idToken: "ya29.not-a-jwt-shaped-token",
        identityToken: "opaque-apple-token",
      }),
    ).toEqual({
      resetToken: "<token>",
      idToken: "<token>",
      identityToken: "<token>",
    });
  });
});
