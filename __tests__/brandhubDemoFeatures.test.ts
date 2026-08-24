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
    // If beforeAll never got a connection there are no fixtures to remove, and
    // querying anyway throws "before initial connection is complete" — a second
    // failure that buries the one that actually mattered.
    if (mongoose.connection.readyState !== 1) return;
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
        {
          title: "Generated inventory",
          generateCodes: { count: 25, prefix: "eco" },
        },
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
    [
      "both code sources",
      { title: "Both", codes: ["ABCD"], generateCodes: { count: 1 } },
    ],
    ["neither code source", { title: "Neither" }],
    [
      "a generated count over 500",
      { title: "Over cap", generateCodes: { count: 501 } },
    ],
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
        {
          title: "Supplied inventory",
          codes: [" eco_123 ", "ECO_123", "SAVE-44"],
        },
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
    await expect(
      CampaignModel.findById(campaign._id).lean(),
    ).resolves.toMatchObject({
      status: "PENDING",
    });
  });

  // Codes could previously only be set at creation, so a campaign that
  // exhausted its pool stopped being redeemable with no way to top it up.
  it("appends discount codes to a campaign, deduping against the existing pool", async () => {
    const campaign = await CampaignModel.create({
      brand: brandId,
      name: "Append codes campaign",
      status: "APPROVED",
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      discountCodes: ["SAVE20", "SAVE20-B"],
    });

    const response = await updateCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns/${campaign._id}`,
        ownerToken,
        { addCodes: ["save20", " SAVE20-C ", "SAVE20-C"] },
      ),
      {
        params: Promise.resolve({
          brandId,
          campaignId: campaign._id.toString(),
        }),
      },
    );
    const body = (await response.json()) as {
      campaign: { discountCodes: string[]; status: string };
    };

    expect(response.status).toBe(200);
    // "save20" already exists and both "SAVE20-C" forms collapse to one.
    expect(body.campaign.discountCodes).toEqual([
      "SAVE20",
      "SAVE20-B",
      "SAVE20-C",
    ]);
  });

  // Appending cannot invalidate a code already handed to a user, so there is
  // nothing for an admin to re-review — and taking the campaign offline is the
  // opposite of what a brand refilling an exhausted pool wants.
  it("leaves an approved campaign approved when only codes are appended", async () => {
    const campaign = await CampaignModel.create({
      brand: brandId,
      name: "Top-up campaign",
      status: "APPROVED",
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      discountCodes: ["ONLY1"],
    });

    const response = await updateCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns/${campaign._id}`,
        ownerToken,
        { addCodes: ["TOPUP1", "TOPUP2"] },
      ),
      {
        params: Promise.resolve({
          brandId,
          campaignId: campaign._id.toString(),
        }),
      },
    );
    const body = (await response.json()) as {
      campaign: { discountCodes: string[]; status: string };
    };

    expect(response.status).toBe(200);
    expect(body.campaign.status).toBe("APPROVED");
    expect(body.campaign.discountCodes).toEqual(["ONLY1", "TOPUP1", "TOPUP2"]);
    await expect(
      CampaignModel.findById(campaign._id).lean(),
    ).resolves.toMatchObject({ status: "APPROVED" });
  });

  // A content edit still re-moderates, even when it arrives alongside addCodes.
  it("re-moderates when a content edit accompanies appended codes", async () => {
    const campaign = await CampaignModel.create({
      brand: brandId,
      name: "Mixed edit campaign",
      status: "APPROVED",
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      discountCodes: ["MIX1"],
    });

    const response = await updateCampaign(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/campaigns/${campaign._id}`,
        ownerToken,
        { addCodes: ["MIX2"], description: "New copy" },
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
  });

  // maxUses is the code count, always: one code is redeemable once, by one
  // user. A client computing it from what it submitted overshoots whenever an
  // overlapping code is dropped.
  it("derives deal maxUses from the real code count after an overlapping re-paste", async () => {
    const deal = await DealModel.create({
      brand: brandId,
      title: "Overlap inventory",
      codes: ["DUP1", "DUP2"],
      promoCode: "DUP1",
      maxUses: 2,
      status: "active",
    });

    const response = await updateDeal(
      jsonRequest(
        `http://localhost/api/brandhub/brands/${brandId}/deals/${deal._id}`,
        ownerToken,
        // Three submitted, but two already exist: only NEW1 is genuinely added.
        { addCodes: ["DUP1", "DUP2", "NEW1"], maxUses: 5 },
      ),
      { params: Promise.resolve({ brandId, dealId: deal._id.toString() }) },
    );
    const body = (await response.json()) as {
      deal: { codes: string[]; maxUses: number };
    };

    expect(response.status).toBe(200);
    expect(body.deal.codes).toEqual(["DUP1", "DUP2", "NEW1"]);
    // Not 5 from the client, and not 2 + 3 = 5 either.
    expect(body.deal.maxUses).toBe(3);
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
      analytics: {
        environmental?: typeof environmentalStats & {
          periodScoped: boolean;
          coverage: null;
        };
      };
    };

    expect(response.status).toBe(200);
    // This brand has environmentalStats but no environmentalPeriods, so the
    // route serves the legacy cumulative snapshot and tags it periodScoped:false
    // with no coverage range — that is what lets the client label the figures
    // all-time instead of implying they followed the date picker.
    expect(body.analytics.environmental).toEqual({
      ...environmentalStats,
      periodScoped: false,
      coverage: null,
    });
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
