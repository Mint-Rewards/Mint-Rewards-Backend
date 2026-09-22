/**
 * Organisations, logins and brands on Postgres.
 *
 * Two things here are worth more than the rest. Rollback, because signup
 * depends on it and the bug it prevents has already happened once in
 * production. And `_id`, because clients merge on it and `ORDER BY id DESC`
 * is what `sort({ _id: -1 })` used to mean — if either quietly changed, the
 * app would break in a way no type would catch.
 *
 * jest.setup.js unsets DATABASE_URL unless DATABASE_URL_TEST is set, so the
 * live half is skipped by default.
 */
import {
  DuplicateKeyError,
  isDuplicateKeyError,
  newObjectId,
} from "@/lib/repositories/brandhub";
import * as repo from "@/lib/repositories/brandhub";

describe("duplicate keys", () => {
  it("recognises Postgres' unique violation", () => {
    // Routes used to test Mongo's 11000 inline. Postgres says 23505, and the
    // point of moving the check here is that they stop needing to know.
    expect(isDuplicateKeyError({ code: "23505" })).toBe(true);
  });

  it("recognises its own error", () => {
    expect(isDuplicateKeyError(new DuplicateKeyError("brands_email_key"))).toBe(
      true,
    );
  });

  it("does not mistake other failures for one", () => {
    expect(isDuplicateKeyError(new Error("connection reset"))).toBe(false);
    expect(isDuplicateKeyError({ code: "23503" })).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });

  it("names the constraint it violated", () => {
    expect(new DuplicateKeyError("brands_email_key").message).toContain(
      "brands_email_key",
    );
  });
});

describe("generated ids", () => {
  it("looks like an ObjectId", () => {
    // Not cosmetic: Campaign and Deal still hold brand ids in Mongo, and
    // findBrandById rejects anything that is not 24 hex characters.
    expect(newObjectId()).toMatch(/^[0-9a-f]{24}$/);
  });

  it("sorts chronologically as text", () => {
    // This is what makes `ORDER BY id DESC` equal `sort({ _id: -1 })`. An
    // ObjectId starts with a big-endian timestamp, so hex order is time order.
    const earlier = newObjectId();
    const later = newObjectId();
    expect(later >= earlier).toBe(true);
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newObjectId()));
    expect(ids.size).toBe(500);
  });
});

describe("against a real database", () => {
  const whenLive = process.env.DATABASE_URL ? describe : describe.skip;

  whenLive("reads", () => {
    afterAll(async () => {
      const { closePostgres } = await import("@/lib/postgres");
      await closePostgres();
    });

    it("returns brands newest first", async () => {
      const found = await repo.findBrands();
      expect(found.length).toBeGreaterThan(0);
      const ids = found.map((b) => b._id);
      expect([...ids].sort().reverse()).toEqual(ids);
    });

    it("hands back _id, not id", async () => {
      const [first] = await repo.findBrands();
      expect(first._id).toMatch(/^[0-9a-f]{24}$/);
      expect((first as unknown as Record<string, unknown>).id).toBeUndefined();
    });

    it("filters by status", async () => {
      const approved = await repo.findBrands({ status: "APPROVED" });
      expect(approved.every((b) => b.status === "APPROVED")).toBe(true);
    });

    it("answers null for a malformed id instead of throwing", async () => {
      // Mongo raised a CastError here. Null is what every caller already
      // handles, and it costs no round trip.
      expect(await repo.findBrandById("not-an-object-id")).toBeNull();
    });

    it("answers null for a well-formed id that does not exist", async () => {
      expect(await repo.findBrandById("0".repeat(24))).toBeNull();
    });

    it("finds an organisation and its subscriptions", async () => {
      const [brand] = await repo.findBrands();
      if (!brand.orgId) return;
      const org = await repo.findOrganizationById(brand.orgId);
      expect(org?._id).toBe(brand.orgId);
      expect(Array.isArray(org?.moduleSubscriptions)).toBe(true);
    });
  });

  whenLive("writes", () => {
    afterAll(async () => {
      const { getPool, closePostgres } = await import("@/lib/postgres");
      await getPool().query(
        "DELETE FROM consumer.brands WHERE email LIKE 'roundtrip-%'",
      );
      await getPool().query(
        "DELETE FROM consumer.brand_users WHERE email LIKE 'roundtrip-%'",
      );
      await getPool().query(
        "DELETE FROM consumer.organizations WHERE name LIKE 'roundtrip-%'",
      );
      await closePostgres();
    });

    it("rolls the whole signup back when the last write fails", async () => {
      // The bug this prevents is real and has shipped: a duplicate brand
      // email returned 409 after the org and login had already committed,
      // leaving people with an account holding zero brands.
      const name = `roundtrip-${Date.now()}`;
      const existing = await repo.findBrands();
      const takenEmail = existing[0].email;

      await expect(
        repo.inTransaction(async (tx) => {
          const org = await repo.createOrganization({ name }, tx);
          await repo.createBrandUser(
            {
              orgId: org._id,
              email: `${name}@example.invalid`,
              passwordHash: "x",
              orgRole: "owner",
            },
            tx,
          );
          // Collides with a brand that already exists.
          await repo.createBrand(
            {
              orgId: org._id,
              companyName: name,
              brandName: name,
              email: takenEmail,
              category: "test",
              webLink: "https://example.invalid",
              contactName: name,
              phone: "0",
              registrationNumber: name,
            },
            tx,
          );
        }),
      ).rejects.toThrow(DuplicateKeyError);

      // Nothing survived — not the org, not the login.
      const { getPool } = await import("@/lib/postgres");
      const orgs = await getPool().query(
        "SELECT 1 FROM consumer.organizations WHERE name = $1",
        [name],
      );
      const users = await getPool().query(
        "SELECT 1 FROM consumer.brand_users WHERE email = $1",
        [`${name}@example.invalid`],
      );
      expect(orgs.rowCount).toBe(0);
      expect(users.rowCount).toBe(0);
    });

    it("commits all three when nothing collides", async () => {
      const name = `roundtrip-ok-${Date.now()}`;
      const brandId = await repo.inTransaction(async (tx) => {
        const org = await repo.createOrganization({ name }, tx);
        await repo.createBrandUser(
          {
            orgId: org._id,
            email: `roundtrip-${Date.now()}@example.invalid`,
            passwordHash: "x",
            orgRole: "owner",
          },
          tx,
        );
        const brand = await repo.createBrand(
          {
            orgId: org._id,
            companyName: name,
            brandName: name,
            email: `roundtrip-${Date.now()}b@example.invalid`,
            category: "test",
            webLink: "https://example.invalid",
            contactName: name,
            phone: "0",
            registrationNumber: name,
          },
          tx,
        );
        return brand._id;
      });

      const saved = await repo.findBrandById(brandId);
      expect(saved?.companyName).toBe(name);
      // Defaults the column supplies, not the caller.
      expect(saved?.status).toBe("PENDING");
      expect(saved?.themeColor).toBe("#3B82F6");
    });

    it("updates and returns the new state", async () => {
      const name = `roundtrip-upd-${Date.now()}`;
      const brand = await repo.createBrand({
        companyName: name,
        brandName: name,
        email: `roundtrip-${Date.now()}u@example.invalid`,
        category: "test",
        webLink: "https://example.invalid",
        contactName: name,
        phone: "0",
        registrationNumber: name,
      });
      const updated = await repo.updateBrand(brand._id, {
        status: "APPROVED",
        description: "changed",
      });
      expect(updated?.status).toBe("APPROVED");
      expect(updated?.description).toBe("changed");
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
        brand.updatedAt.getTime(),
      );
    });
  });
});
