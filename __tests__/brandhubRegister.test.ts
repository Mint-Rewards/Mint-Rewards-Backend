/// <reference types="jest" />

import mongoose from "mongoose";
import { NextRequest } from "next/server";
import connectToDatabase from "../lib/mongodb";
import {
  createBrand,
  deleteBrandsByIds,
  findBrandUserByEmail,
} from "../lib/repositories/brandhub";
import { closePostgres, getPool } from "../lib/postgres";
import { POST as register } from "../app/api/brandhub/auth/register/route";

// Registration creates three documents: Organization, BrandUser and Brand.
// They used to be written one at a time with no transaction, so a duplicate
// Brand email returned 409 *after* the org and owner were already committed.
// The user was then stranded: they held an account they could log into with
// zero brands, and retrying failed earlier still, on the BrandUser duplicate
// check, with "Email already in use" (issue #99).

function registerRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/brandhub/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/brandhub/auth/register", () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const takenEmail = `taken-${suffix}@example.com`;
  const freshEmail = `fresh-${suffix}@example.com`;

  const orgIds: string[] = [];
  const brandIds: string[] = [];

  beforeAll(async () => {
    await connectToDatabase();

    // An unrelated Brand already holding the address the signup will use.
    // Brand.email is uniquely indexed, so the Brand insert below must fail.
    const squatter = await createBrand({
      companyName: `Squatter ${suffix}`,
      brandName: `Squatter ${suffix}`,
      email: takenEmail,
      category: "general",
      webLink: "https://example.com",
      contactName: "Existing Owner",
      phone: "0000000000",
      registrationNumber: `SQUAT-${suffix}`,
      status: "APPROVED",
      role: "BRAND",
    });
    brandIds.push(squatter._id);
  });

  afterAll(async () => {
    // Raw SQL for teardown: deleting by email or by a name pattern is not
    // something a route should be able to do, so the repository does not
    // offer it.
    const pool = getPool();
    await deleteBrandsByIds(brandIds);
    await pool.query("DELETE FROM consumer.brands WHERE email = ANY($1)", [
      [takenEmail, freshEmail],
    ]);
    await pool.query("DELETE FROM consumer.brand_users WHERE email = ANY($1)", [
      [takenEmail, freshEmail],
    ]);
    await pool.query("DELETE FROM consumer.brand_users WHERE org_id = ANY($1)", [
      orgIds,
    ]);
    await pool.query(
      "DELETE FROM consumer.organizations WHERE id = ANY($1) OR name LIKE 'Rollback Test Org%'",
      [orgIds],
    );
    await closePostgres();
    await mongoose.disconnect();
  });

  it("rolls back the organization and owner when brand creation fails", async () => {
    const response = await register(
      registerRequest({
        orgName: `Rollback Test Org ${suffix}`,
        email: takenEmail,
        password: "correct-horse-battery",
        brandName: `Rollback Brand ${suffix}`,
      }),
    );

    expect(response.status).toBe(409);

    // The whole point: nothing survived the failed signup.
    const orgs = await getPool().query(
      "SELECT 1 FROM consumer.organizations WHERE name = $1",
      [`Rollback Test Org ${suffix}`],
    );
    expect(orgs.rowCount).toBe(0);
    await expect(findBrandUserByEmail(takenEmail)).resolves.toBeNull();
  });

  it("lets the user retry with a different email and get a working account", async () => {
    const response = await register(
      registerRequest({
        orgName: `Rollback Test Org retry ${suffix}`,
        email: freshEmail,
        password: "correct-horse-battery",
        brandName: `Retry Brand ${suffix}`,
      }),
    );

    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      token: string;
      orgId: string;
      userId: string;
      brands: { id: string }[];
      defaultBrandId: string | null;
    };

    expect(body.token).toEqual(expect.any(String));
    expect(body.brands).toHaveLength(1);
    expect(body.defaultBrandId).toBe(body.brands[0].id);

    orgIds.push(body.orgId);
    brandIds.push(body.brands[0].id);

    await expect(findBrandUserByEmail(freshEmail)).resolves.toMatchObject({
      orgRole: "owner",
    });
  });
});
