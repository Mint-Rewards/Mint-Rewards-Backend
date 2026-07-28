/// <reference types="jest" />

import mongoose from "mongoose";
import { NextRequest } from "next/server";
import connectToDatabase from "../lib/mongodb";
import { BrandModel, CampaignModel, OrganizationModel } from "../lib/models";
import { signBrandToken } from "../lib/brandJwt";
import { POST as createLegacyCampaign } from "../app/api/brands/[id]/campaigns/route";
import { POST as createBrandhubCampaign } from "../app/api/brandhub/brands/[brandId]/campaigns/route";

function jsonRequest(url: string, token: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Campaign creation — cities", () => {
  let orgId: string;
  let brandId: string;
  let brandToken: string;

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    const org = await OrganizationModel.create({
      name: `Cities Create Test Org ${suffix}`,
      moduleSubscriptions: [
        {
          module: "consumer-reporting",
          status: "active",
          activatedAt: new Date(),
          expiresAt: null,
        },
      ],
    });
    orgId = org._id.toString();

    const brand = await BrandModel.create({
      orgId: org._id,
      brandName: `Cities Create Brand ${suffix}`,
      companyName: "Cities Create Co",
      email: `cities-create-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber: `CITIES-CREATE-${suffix}`,
      status: "APPROVED",
    });
    brandId = brand._id.toString();

    brandToken = signBrandToken({
      sub: new mongoose.Types.ObjectId().toString(),
      orgId,
      orgRole: "owner",
      moduleAccess: [],
    });
  });

  afterEach(async () => {
    await CampaignModel.deleteMany({ brand: brandId });
  });

  afterAll(async () => {
    await Promise.all([
      CampaignModel.deleteMany({ brand: brandId }),
      BrandModel.deleteOne({ _id: brandId }),
      OrganizationModel.deleteOne({ _id: orgId }),
    ]);
    await mongoose.disconnect();
  });

  it("legacy route: creates an untargeted campaign when cities is omitted", async () => {
    const response = await createLegacyCampaign(
      jsonRequest(`http://localhost/api/brands/${brandId}/campaigns`, brandToken, {
        name: "No cities",
      }),
      { params: Promise.resolve({ id: brandId }) },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { campaign: { cities: string[] } };
    expect(body.campaign.cities).toEqual([]);
  });

  it("legacy route: creates a campaign with a valid city subset", async () => {
    const response = await createLegacyCampaign(
      jsonRequest(`http://localhost/api/brands/${brandId}/campaigns`, brandToken, {
        name: "Targeted",
        cities: ["Lahore", "Karachi"],
      }),
      { params: Promise.resolve({ id: brandId }) },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { campaign: { cities: string[] } };
    expect(body.campaign.cities).toEqual(["Lahore", "Karachi"]);
  });

  it("legacy route: rejects an invalid city with 400 and creates nothing", async () => {
    const before = await CampaignModel.countDocuments({ brand: brandId });
    const response = await createLegacyCampaign(
      jsonRequest(`http://localhost/api/brands/${brandId}/campaigns`, brandToken, {
        name: "Bad",
        cities: ["Peshawar"],
      }),
      { params: Promise.resolve({ id: brandId }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("Peshawar");
    const after = await CampaignModel.countDocuments({ brand: brandId });
    expect(after).toBe(before);
  });

  it("brandhub route: creates a campaign with a valid city subset", async () => {
    const response = await createBrandhubCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns`,
        brandToken,
        { name: "Brandhub targeted", cities: ["Islamabad"] },
      ),
      { params: Promise.resolve({ brandId }) },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { campaign: { cities: string[] } };
    expect(body.campaign.cities).toEqual(["Islamabad"]);
  });

  it("brandhub route: rejects an invalid city with 400", async () => {
    const response = await createBrandhubCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns`,
        brandToken,
        { name: "Brandhub bad", cities: ["Quetta"] },
      ),
      { params: Promise.resolve({ brandId }) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("Quetta");
  });
});
