/// <reference types="jest" />

import mongoose from "mongoose";
import { NextRequest } from "next/server";
import connectToDatabase from "../lib/mongodb";
import { BrandModel, BrandUserModel, OrganizationModel } from "../lib/models";
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

  const orgIds: mongoose.Types.ObjectId[] = [];
  const brandIds: mongoose.Types.ObjectId[] = [];

  beforeAll(async () => {
    await connectToDatabase();

    // An unrelated Brand already holding the address the signup will use.
    // Brand.email is uniquely indexed, so the Brand insert below must fail.
    const squatter = await BrandModel.create({
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
    await Promise.all([
      BrandModel.deleteMany({ _id: { $in: brandIds } }),
      BrandModel.deleteMany({ email: { $in: [takenEmail, freshEmail] } }),
      BrandUserModel.deleteMany({ email: { $in: [takenEmail, freshEmail] } }),
      OrganizationModel.deleteMany({ _id: { $in: orgIds } }),
      OrganizationModel.deleteMany({ name: /Rollback Test Org/ }),
    ]);
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
    await expect(
      OrganizationModel.findOne({ name: `Rollback Test Org ${suffix}` }).lean(),
    ).resolves.toBeNull();
    await expect(
      BrandUserModel.findOne({ email: takenEmail }).lean(),
    ).resolves.toBeNull();
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

    orgIds.push(new mongoose.Types.ObjectId(body.orgId));
    brandIds.push(new mongoose.Types.ObjectId(body.brands[0].id));

    await expect(
      BrandUserModel.findOne({ email: freshEmail }).lean(),
    ).resolves.toMatchObject({ orgRole: "owner" });
  });
});
