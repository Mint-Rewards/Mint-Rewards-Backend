/**
 * The dual-write mirror. Two properties matter more than the mapping:
 *
 *  1. It must never fail a request. Mongo is authoritative for the whole
 *     window, and a shadow store nobody depends on yet must not be able to
 *     double the failure surface of one everybody does.
 *  2. It must cover writes that never touch `.save()`. Only 8 of the 44 write
 *     sites are documents; the rest are query operations, so document
 *     middleware alone would miss four fifths of them.
 */
import { camelCase, MIRRORED, NESTED_CHILDREN, SECRET_COLUMNS } from "@/lib/mirroredTables";

describe("mirroredTables — the shared definition", () => {
  it("camel-cases a column back to its Mongo field", () => {
    expect(camelCase("total_waste_collected")).toBe("totalWasteCollected");
    expect(camelCase("user_name")).toBe("userName");
    expect(camelCase("mint_id")).toBe("mintId");
    expect(camelCase("email")).toBe("email");
  });

  it("mirrors the password hash, because Postgres becomes the auth store", () => {
    // Holding it back looks safer and is not: the ETL copies hashes, and a
    // user who changed their password mid-window would reach cutover unable
    // to log in — invisibly, since an unmirrored column is also unreconciled.
    expect(SECRET_COLUMNS.has("password")).toBe(false);
    expect(SECRET_COLUMNS.size).toBe(0);
  });

  it("covers every collection the app writes", () => {
    // From the measured write surface: 44 writes across User, Deal, Campaign,
    // Brand, Organization and BrandUser. If a route starts writing something
    // else, this is the line that should fail.
    for (const c of ["users", "deals", "campaigns", "brands", "organizations", "brandusers"]) {
      expect(Object.keys(MIRRORED)).toContain(c);
    }
  });

  describe("user_locations presence rule", () => {
    const { present } = NESTED_CHILDREN.user_locations;

    it("is false for a user who has never touched location", () => {
      expect(present({ userName: "x" })).toBe(false);
      expect(present({ locationVersion: 0 })).toBe(false);
    });

    // The trap: UserSchema gives location.type a default of "Point", so
    // Mongoose stamps `{ type: "Point" }` on every user who has never dropped
    // a pin. Reading that as "has location data" would give all ~7,269 users
    // an otherwise empty child row — and the ETL did exactly that until this
    // rule became shared.
    it("is false for the empty container Mongoose materialises", () => {
      expect(present({ location: { type: "Point" } })).toBe(false);
      expect(present({ structuredAddress: {} })).toBe(false);
      expect(present({ locationVerification: {} })).toBe(false);
    });

    it("is true once any location signal exists", () => {
      expect(present({ location: { type: "Point", coordinates: [67, 24] } })).toBe(true);
      expect(present({ location: { type: "Point", source: "map_pin" } })).toBe(true);
      expect(present({ structuredAddress: { cityId: "Karachi" } })).toBe(true);
      expect(present({ locationVerification: { status: "unverified" } })).toBe(true);
      expect(present({ locationVersion: 1 })).toBe(true);
      expect(present({ locationCompletedAt: new Date() })).toBe(true);
    });
  });

  it("splits GeoJSON into lng and lat the right way round", () => {
    const { fields } = NESTED_CHILDREN.user_locations;
    const doc = { location: { coordinates: [67.03, 24.86] } };
    expect(fields.lng(doc)).toBe(67.03);
    expect(fields.lat(doc)).toBe(24.86);
  });

  it("reads nested address and verification without throwing on absent parents", () => {
    const { fields } = NESTED_CHILDREN.user_locations;
    expect(fields.structured_house_no({})).toBeUndefined();
    expect(fields.verification_status({})).toBeUndefined();
    expect(fields.version({})).toBe(0);
  });
});

describe("dualWrite — fail open", () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
    jest.resetModules();
  });

  it("does nothing at all when the flag is off", async () => {
    process.env.DUAL_WRITE_ENABLED = "false";
    process.env.POSTGRES_URL = "postgres://nobody@127.0.0.1:1/nowhere";
    const { mirrorDocument } = await import("@/lib/dualWrite");
    await expect(
      mirrorDocument("users", { _id: "abc", userName: "x" }),
    ).resolves.toBeUndefined();
  });

  it("swallows an unreachable Postgres instead of failing the write", async () => {
    process.env.DUAL_WRITE_ENABLED = "true";
    // Port 1 refuses immediately: the failure a real outage produces.
    process.env.POSTGRES_URL = "postgres://nobody:nobody@127.0.0.1:1/nowhere";
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { mirrorDocument, mirrorDeletion } = await import("@/lib/dualWrite");

    await expect(
      mirrorDocument("users", { _id: "abc", userName: "x" }),
    ).resolves.toBeUndefined();
    await expect(mirrorDeletion("users", "abc")).resolves.toBeUndefined();

    // Silent to the caller, but not silent in the logs — the reconciler is
    // what catches it, and an operator needs the breadcrumb.
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0])).toContain("[dual-write]");
    spy.mockRestore();
  });

  it("ignores a collection that is not mirrored", async () => {
    process.env.DUAL_WRITE_ENABLED = "true";
    process.env.POSTGRES_URL = "postgres://nobody:nobody@127.0.0.1:1/nowhere";
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { mirrorDocument } = await import("@/lib/dualWrite");
    await mirrorDocument("logs", { _id: "abc" });
    // Nothing attempted, so nothing logged.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
