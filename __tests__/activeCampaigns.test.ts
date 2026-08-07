/// <reference types="jest" />

import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import connectToDatabase from "../lib/mongodb";
import { BrandModel, CampaignModel } from "../lib/models";
import { GET as getActiveCampaigns } from "../app/api/users/active-campaigns/route";

// The public brand list and the campaign list must agree on brand identity.
// Production data has two documents per brand: a legacy one, and the BrandHub
// document (scripts/clone-legacy-brands.js) that campaigns are linked against.
// The app lists APPROVED brands, so once the clone is approved both documents
// qualify — the route must list the clone alone rather than the brand twice.
// Campaigns predating the migration still reference the legacy id, so the
// response must key every campaign to a brand id it actually returns —
// otherwise the brand card renders "No active campaigns".
function userRequest(userId: string): Request {
  const secret =
    process.env.JWT_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.NEXT_JWT_SECRET ||
    "";
  const token = jwt.sign({ id: userId }, secret);
  return new Request("http://localhost/api/users/active-campaigns", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("GET /api/users/active-campaigns", () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const userId = new mongoose.Types.ObjectId().toString();
  let legacyBrandId: string;
  let cloneBrandId: string;
  let campaignId: string;
  let legacyLinkedCampaignId: string;
  let pendingBrandId: string;

  beforeAll(async () => {
    await connectToDatabase();

    // Original brand doc: APPROVED, no registrationNumber, minimal legacy shape.
    const legacy = await BrandModel.collection.insertOne({
      companyName: `Legacy Brand ${suffix}`,
      brandName: `Legacy Brand ${suffix}`,
      email: `original-${suffix}@example.com`,
      logo: "https://example.com/logo.png",
      category: "Retail",
      themeColor: "#242E2E",
      status: "APPROVED",
    } as any);
    legacyBrandId = legacy.insertedId.toString();

    const registrationNumber = `reg-${suffix}`;
    const clone = await BrandModel.create({
      companyName: `Legacy Brand ${suffix}`,
      brandName: `Legacy Brand ${suffix}`,
      email: `legacy-${legacyBrandId}@example.com`,
      logo: "https://example.com/logo.png",
      category: "Retail",
      description: "",
      address: "",
      webLink: "https://example.com",
      appLink: "",
      contactName: "N/A",
      phone: "0000000000",
      registrationNumber,
      themeColor: "#242E2E",
      // Approved in BrandHub — the state in which the app lists it.
      status: "APPROVED",
      role: "BRAND",
    });
    cloneBrandId = clone._id.toString();

    // Inserted raw: `brandId` is not in CampaignSchema, so create() would drop it.
    const campaign = await CampaignModel.collection.insertOne({
      name: `20% off ${suffix}`,
      startDate: "2025-02-04",
      endDate: "2099-12-31",
      discountPercentage: "20",
      status: "APPROVED",
      brand: clone._id,
      brandId: new mongoose.Types.ObjectId(legacyBrandId),
      brandRegistration: registrationNumber,
      addresses: [],
    } as any);
    campaignId = campaign.insertedId.toString();

    // A campaign never repointed by the migration: it still names the legacy
    // brand and carries no registration, so the legacy-* email pairing is the
    // only route back to the listed BrandHub brand.
    const legacyLinked = await CampaignModel.collection.insertOne({
      name: `5% off ${suffix}`,
      startDate: "2025-02-04",
      endDate: "2099-12-31",
      discountPercentage: "5",
      status: "APPROVED",
      brand: new mongoose.Types.ObjectId(legacyBrandId),
      addresses: [],
    } as any);
    legacyLinkedCampaignId = legacyLinked.insertedId.toString();

    // A brand awaiting review. Nothing about it should reach the app until an
    // admin approves it in BrandHub.
    const pending = await BrandModel.create({
      companyName: `Pending Brand ${suffix}`,
      brandName: `Pending Brand ${suffix}`,
      email: `pending-${suffix}@example.com`,
      category: "Retail",
      description: "",
      address: "",
      webLink: "https://example.com",
      appLink: "",
      contactName: "N/A",
      phone: "0000000000",
      registrationNumber: `pending-reg-${suffix}`,
      themeColor: "#242E2E",
      status: "PENDING",
      role: "BRAND",
    });
    pendingBrandId = pending._id.toString();
  });

  afterAll(async () => {
    await CampaignModel.deleteMany({
      _id: { $in: [campaignId, legacyLinkedCampaignId] },
    });
    await BrandModel.deleteMany({
      _id: {
        $in: [legacyBrandId, cloneBrandId, pendingBrandId].map(
          (id) => new mongoose.Types.ObjectId(id),
        ),
      },
    });
    await mongoose.disconnect();
  });

  it("lists the approved BrandHub brand, not its legacy counterpart", async () => {
    const response = await getActiveCampaigns(userRequest(userId));
    const data = await response.json();

    const ids = data.activeBrands.map((b: any) => String(b._id));
    expect(ids).toContain(cloneBrandId);
    expect(ids).not.toContain(legacyBrandId);
  });

  it("keys each active campaign to a brand id present in activeBrands", async () => {
    const response = await getActiveCampaigns(userRequest(userId));
    const data = await response.json();

    const brandIds = new Set(data.activeBrands.map((b: any) => String(b._id)));
    const campaign = data.activeCampaigns.find(
      (c: any) => String(c._id) === campaignId,
    );

    expect(campaign).toBeDefined();
    expect(String(campaign.brand)).toBe(cloneBrandId);
    expect(brandIds.has(String(campaign.brand))).toBe(true);
  });

  it("withholds a brand still awaiting admin approval", async () => {
    const response = await getActiveCampaigns(userRequest(userId));
    const data = await response.json();

    const ids = data.activeBrands.map((b: any) => String(b._id));
    expect(ids).not.toContain(pendingBrandId);
  });

  it("resolves a campaign still pointing at the legacy brand id", async () => {
    const response = await getActiveCampaigns(userRequest(userId));
    const data = await response.json();

    const campaign = data.activeCampaigns.find(
      (c: any) => String(c._id) === legacyLinkedCampaignId,
    );

    expect(campaign).toBeDefined();
    expect(String(campaign.brand)).toBe(cloneBrandId);
  });
});
