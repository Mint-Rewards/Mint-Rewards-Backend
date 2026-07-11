/// <reference types="jest" />

import mongoose from "mongoose";
import { NextRequest } from "next/server";
import connectToDatabase from "../lib/mongodb";
import {
  BrandModel,
  CampaignModel,
  DealModel,
  OrganizationModel,
} from "../lib/models";
import { signBrandToken } from "../lib/brandJwt";
import { POST as createDeal } from "../app/api/brandhub/brands/[brandId]/deals/route";
import { PATCH as updateDeal } from "../app/api/brandhub/brands/[brandId]/deals/[dealId]/route";
import { PATCH as updateCampaign } from "../app/api/brandhub/brands/[brandId]/campaigns/[campaignId]/route";
import { GET as getAnalytics } from "../app/api/brandhub/brands/[brandId]/analytics/route";

function jsonRequest(url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("BrandHub demo features", () => {
  let orgId: string;
  let brandId: string;
  let ownerToken: string;

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    const org = await OrganizationModel.create({
      name: `Demo Features Test Org ${suffix}`,
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
      brandName: `Demo Features Brand ${suffix}`,
      companyName: "Demo Features Co",
      email: `demo-features-${suffix}@example.com`,
      category: "general",
      description: "Integration-test brand",
      address: "1 Test Street",
      webLink: "https://example.com",
      appLink: "",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber: `DEMO-${suffix}`,
      domain: "",
      status: "APPROVED",
      emailVerified: true,
    });
    brandId = brand._id.toString();

    ownerToken = signBrandToken({
      sub: new mongoose.Types.ObjectId().toString(),
      orgId,
      orgRole: "owner",
      moduleAccess: [],
    });
  });

  beforeEach(async () => {
    await Promise.all([
      CampaignModel.deleteMany({ brand: brandId }),
      DealModel.deleteMany({ brand: brandId }),
      BrandModel.updateOne(
        { _id: brandId },
        { $unset: { environmentalStats: 1 } },
      ),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      CampaignModel.deleteMany({ brand: brandId }),
      DealModel.deleteMany({ brand: brandId }),
      BrandModel.deleteOne({ _id: brandId }),
      OrganizationModel.deleteOne({ _id: orgId }),
    ]);
    await mongoose.disconnect();
  });

  it("generates 25 unique codes with the unambiguous alphabet and mirrors the first", async () => {
    const response = await createDeal(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/deals`,
        ownerToken,
        { title: "Generated inventory", generateCodes: { count: 25, prefix: "eco" } },
      ),
      { params: Promise.resolve({ brandId }) },
    );
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      deal: { codes: string[]; promoCode: string };
    };
    expect(body.deal.codes).toHaveLength(25);
    expect(new Set(body.deal.codes).size).toBe(25);
    expect(body.deal.codes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ECO-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/),
      ]),
    );
    for (const code of body.deal.codes) {
      expect(code).toMatch(/^ECO-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    }
    expect(body.deal.promoCode).toBe(body.deal.codes[0]);
  });

  it.each([
    ["both code sources", { title: "Both", codes: ["ABCD"], generateCodes: { count: 1 } }],
    ["neither code source", { title: "Neither" }],
    ["a generated count over 500", { title: "Over cap", generateCodes: { count: 501 } }],
  ])("returns 400 for %s", async (_label, payload) => {
    const response = await createDeal(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/deals`,
        ownerToken,
        payload,
      ),
      { params: Promise.resolve({ brandId }) },
    );
    expect(response.status).toBe(400);
  });

  it("normalizes and dedupes supplied codes and reports every rejected code", async () => {
    const invalid = await createDeal(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/deals`,
        ownerToken,
        { title: "Invalid inventory", codes: ["GOOD-44", "bad!", "x"] },
      ),
      { params: Promise.resolve({ brandId }) },
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      message: expect.stringContaining("bad!, x"),
    });

    const valid = await createDeal(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/deals`,
        ownerToken,
        { title: "Supplied inventory", codes: [" eco_123 ", "ECO_123", "SAVE-44"] },
      ),
      { params: Promise.resolve({ brandId }) },
    );
    const body = (await valid.json()) as {
      deal: { codes: string[]; promoCode: string };
    };
    expect(valid.status).toBe(201);
    expect(body.deal.codes).toEqual(["ECO_123", "SAVE-44"]);
    expect(body.deal.promoCode).toBe("ECO_123");
  });

  it("appends codes without removing inventory or changing promoCode", async () => {
    const deal = await DealModel.create({
      brand: brandId,
      title: "Append inventory",
      codes: ["FIRST1"],
      promoCode: "FIRST1",
    });

    const response = await updateDeal(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/deals/${deal._id}`,
        ownerToken,
        { addCodes: ["FIRST1", " second2 "] },
      ),
      { params: Promise.resolve({ brandId, dealId: deal._id.toString() }) },
    );
    const body = (await response.json()) as {
      deal: { codes: string[]; promoCode: string; codeCount: number };
    };
    expect(response.status).toBe(200);
    expect(body.deal.codes).toEqual(["FIRST1", "SECOND2"]);
    expect(body.deal.codeCount).toBe(2);
    expect(body.deal.promoCode).toBe("FIRST1");
  });

  it("resets an approved campaign to PENDING after a brand edit", async () => {
    const campaign = await CampaignModel.create({
      brand: brandId,
      name: "Approved campaign",
      status: "APPROVED",
      startDate: "2020-01-01",
      endDate: "2099-12-31",
    });

    const response = await updateCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns/${campaign._id}`,
        ownerToken,
        { description: "Brand-edited copy" },
      ),
      {
        params: Promise.resolve({
          brandId,
          campaignId: campaign._id.toString(),
        }),
      },
    );
    const body = (await response.json()) as { campaign: { status: string } };
    expect(response.status).toBe(200);
    expect(body.campaign.status).toBe("PENDING");
    await expect(CampaignModel.findById(campaign._id).lean()).resolves.toMatchObject({
      status: "PENDING",
    });
  });

  it("returns campaign and deal counts from live brand-scoped fixtures", async () => {
    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();
    await CampaignModel.create([
      {
        brand: brandId,
        name: "Active approved",
        status: "APPROVED",
        startDate: "2020-01-01",
        endDate: "2099-12-31",
        users: [userA, userB],
      },
      {
        brand: brandId,
        name: "Ended approved",
        status: "APPROVED",
        startDate: "2020-01-01",
        endDate: "2020-12-31",
        users: [userA],
      },
      { brand: brandId, name: "Pending", status: "PENDING" },
      { brand: brandId, name: "Rejected", status: "REJECTED" },
      { brand: brandId, name: "Expired", status: "EXPIRED" },
    ]);
    await DealModel.create([
      { brand: brandId, title: "Active one", status: "active" },
      { brand: brandId, title: "Active two", status: "active" },
      { brand: brandId, title: "Inactive", status: "inactive" },
      { brand: brandId, title: "Expired", status: "expired" },
    ]);

    const response = await getAnalytics(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/analytics`,
        ownerToken,
      ),
      { params: Promise.resolve({ brandId }) },
    );
    const body = (await response.json()) as {
      analytics: {
        summary: Record<string, number>;
        campaigns: { byStatus: Record<string, number>; active: unknown[] };
        dealStats: Record<string, number>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.analytics.summary).toEqual({
      totalCampaigns: 5,
      activeCampaigns: 1,
      totalRedemptions: 3,
      uniqueUsers: 2,
    });
    expect(body.analytics.campaigns.byStatus).toEqual({
      APPROVED: 2,
      PENDING: 1,
      REJECTED: 1,
      EXPIRED: 1,
    });
    expect(body.analytics.campaigns.active).toHaveLength(1);
    expect(body.analytics.dealStats).toEqual({
      total: 4,
      active: 2,
      inactive: 1,
      expired: 1,
    });
  });

  it("returns seeded environmental figures when the brand has impact data", async () => {
    const environmentalStats = {
      totalWasteKg: 1240,
      co2AvoidedKg: 1860,
      materialBreakdown: [
        { material: "Plastic", weightKg: 520 },
        { material: "Aluminum", weightKg: 260 },
        { material: "Paper", weightKg: 300 },
        { material: "Glass", weightKg: 160 },
      ],
    };
    await BrandModel.updateOne(
      { _id: brandId },
      { $set: { environmentalStats } },
    );

    const response = await getAnalytics(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/analytics`,
        ownerToken,
      ),
      { params: Promise.resolve({ brandId }) },
    );
    const body = (await response.json()) as {
      analytics: { environmental?: typeof environmentalStats };
    };

    expect(response.status).toBe(200);
    expect(body.analytics.environmental).toEqual(environmentalStats);
  });

  it("omits environmental when the brand has no impact data", async () => {
    const response = await getAnalytics(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/analytics`,
        ownerToken,
      ),
      { params: Promise.resolve({ brandId }) },
    );
    const body = (await response.json()) as {
      analytics: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.analytics).not.toHaveProperty("environmental");
  });
});
