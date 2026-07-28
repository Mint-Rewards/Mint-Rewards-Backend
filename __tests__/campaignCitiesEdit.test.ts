/// <reference types="jest" />

import mongoose from "mongoose";
import { NextRequest } from "next/server";
import connectToDatabase from "../lib/mongodb";
import { BrandModel, CampaignModel, OrganizationModel } from "../lib/models";
import { signBrandToken } from "../lib/brandJwt";
import { PATCH as patchLegacyCampaign } from "../app/api/brands/[id]/campaigns/[campaignId]/route";
import { PATCH as patchBrandhubCampaign } from "../app/api/brandhub/brands/[brandId]/campaigns/[campaignId]/route";

function jsonRequest(url: string, token: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Campaign edit — cities", () => {
  let orgId: string;
  let brandId: string;
  let brandToken: string;

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    const org = await OrganizationModel.create({
      name: `Cities Edit Test Org ${suffix}`,
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
      brandName: `Cities Edit Brand ${suffix}`,
      companyName: "Cities Edit Co",
      email: `cities-edit-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber: `CITIES-EDIT-${suffix}`,
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

  it("legacy route: updates cities on an existing campaign", async () => {
    const campaign = await CampaignModel.create({ name: "Edit me", brand: brandId });

    const response = await patchLegacyCampaign(
      jsonRequest(
        `http://localhost/api/brands/${brandId}/campaigns/${campaign._id}`,
        brandToken,
        { cities: ["Multan", "Hyderabad"] },
      ),
      { params: Promise.resolve({ id: brandId, campaignId: campaign._id.toString() }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { campaign: { cities: string[] } };
    expect(body.campaign.cities).toEqual(["Multan", "Hyderabad"]);
  });

  it("legacy route: rejects an invalid city and leaves the campaign unchanged", async () => {
    const campaign = await CampaignModel.create({
      name: "Stays targeted",
      brand: brandId,
      cities: ["Lahore"],
    });

    const response = await patchLegacyCampaign(
      jsonRequest(
        `http://localhost/api/brands/${brandId}/campaigns/${campaign._id}`,
        brandToken,
        { cities: ["Peshawar"] },
      ),
      { params: Promise.resolve({ id: brandId, campaignId: campaign._id.toString() }) },
    );
    expect(response.status).toBe(400);

    const unchanged = await CampaignModel.findById(campaign._id).lean();
    expect(unchanged?.cities).toEqual(["Lahore"]);
  });

  it("brandhub route: updates cities and resets status to PENDING", async () => {
    const campaign = await CampaignModel.create({
      name: "Approved, edit cities",
      brand: brandId,
      status: "APPROVED",
    });

    const response = await patchBrandhubCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns/${campaign._id}`,
        brandToken,
        { cities: ["Faisalabad"] },
      ),
      {
        params: Promise.resolve({ brandId, campaignId: campaign._id.toString() }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      campaign: { cities: string[]; status: string };
    };
    expect(body.campaign.cities).toEqual(["Faisalabad"]);
    expect(body.campaign.status).toBe("PENDING");
  });

  it("brandhub route: rejects an invalid city", async () => {
    const campaign = await CampaignModel.create({ name: "Bad edit", brand: brandId });

    const response = await patchBrandhubCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns/${campaign._id}`,
        brandToken,
        { cities: ["Quetta"] },
      ),
      {
        params: Promise.resolve({ brandId, campaignId: campaign._id.toString() }),
      },
    );
    expect(response.status).toBe(400);
  });
});
