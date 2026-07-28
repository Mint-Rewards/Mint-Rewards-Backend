/// <reference types="jest" />

import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import connectToDatabase from "../lib/mongodb";
import { serverEnv } from "../lib/env";
import { BrandModel, CampaignModel, UserModel } from "../lib/models";
import { GET as getActiveCampaigns } from "../app/api/users/active-campaigns/route";

describe("GET /api/users/active-campaigns — city filter", () => {
  let brandId: string;
  let untargetedCampaignId: string;
  let lahoreCampaignId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    const brand = await BrandModel.create({
      companyName: "City Filter Co",
      brandName: `City Filter Brand ${suffix}`,
      email: `city-filter-brand-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber: `CITY-FILTER-${suffix}`,
      status: "APPROVED",
    });
    brandId = brand._id.toString();

    const untargeted = await CampaignModel.create({
      name: "Untargeted",
      brand: brandId,
      status: "APPROVED",
      startDate: "2020-01-01",
      endDate: "2099-12-31",
    });
    untargetedCampaignId = untargeted._id.toString();

    const lahoreOnly = await CampaignModel.create({
      name: "Lahore only",
      brand: brandId,
      status: "APPROVED",
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      cities: ["Lahore"],
    });
    lahoreCampaignId = lahoreOnly._id.toString();
  });

  afterAll(async () => {
    await Promise.all([
      CampaignModel.deleteMany({ brand: brandId }),
      BrandModel.deleteOne({ _id: brandId }),
      UserModel.deleteMany({ _id: { $in: createdUserIds } }),
    ]);
    await mongoose.disconnect();
  });

  async function fetchAsUser(city?: string) {
    const suffix = new mongoose.Types.ObjectId().toString();
    const user = await UserModel.create({
      userName: "City Filter Tester",
      email: `city-filter-user-${suffix}@example.com`,
      password: "irrelevant-hash",
      mintId: `MINT-${suffix}`,
      ...(city !== undefined && { city }),
    });
    createdUserIds.push(user._id.toString());
    const token = jwt.sign({ id: user._id.toString() }, serverEnv.jwtSecret);

    const req = new Request("http://localhost/api/users/active-campaigns", {
      headers: { authorization: `Bearer ${token}` },
    });
    const response = await getActiveCampaigns(req);
    const body = (await response.json()) as {
      activeCampaigns: { _id: string }[];
    };
    return body.activeCampaigns.map((c) => c._id.toString());
  }

  it("shows both campaigns to a user in the targeted city", async () => {
    const ids = await fetchAsUser("Lahore");
    expect(ids).toEqual(
      expect.arrayContaining([untargetedCampaignId, lahoreCampaignId]),
    );
  });

  it("hides the targeted campaign from a user in a different city", async () => {
    const ids = await fetchAsUser("Karachi");
    expect(ids).toContain(untargetedCampaignId);
    expect(ids).not.toContain(lahoreCampaignId);
  });

  it("hides the targeted campaign from a user with no city set", async () => {
    const ids = await fetchAsUser(undefined);
    expect(ids).toContain(untargetedCampaignId);
    expect(ids).not.toContain(lahoreCampaignId);
  });
});
