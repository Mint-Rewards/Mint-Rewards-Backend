/// <reference types="jest" />

import mongoose from "mongoose";
import connectToDatabase from "../lib/mongodb";
import { BrandModel, CampaignModel } from "../lib/models";

describe("Campaign.cities field", () => {
  let brandId: string;

  beforeAll(async () => {
    await connectToDatabase();
    const suffix = new mongoose.Types.ObjectId().toString();
    const brand = await BrandModel.create({
      companyName: "Cities Schema Test Co",
      brandName: `Cities Schema Brand ${suffix}`,
      email: `cities-schema-${suffix}@example.com`,
      category: "general",
      webLink: "https://example.com",
      contactName: "Test Owner",
      phone: "N/A",
      registrationNumber: `CITIES-SCHEMA-${suffix}`,
      status: "APPROVED",
    });
    brandId = brand._id.toString();
  });

  afterAll(async () => {
    await Promise.all([
      CampaignModel.deleteMany({ brand: brandId }),
      BrandModel.deleteOne({ _id: brandId }),
    ]);
    await mongoose.disconnect();
  });

  it("defaults to an empty array when not provided", async () => {
    const campaign = await CampaignModel.create({
      name: "Untargeted campaign",
      brand: brandId,
    });
    expect(campaign.cities).toEqual([]);
  });

  it("accepts a subset of the fixed city list", async () => {
    const campaign = await CampaignModel.create({
      name: "Targeted campaign",
      brand: brandId,
      cities: ["Lahore", "Karachi"],
    });
    expect(campaign.cities).toEqual(["Lahore", "Karachi"]);
  });

  it("rejects a city outside the fixed list at the schema level", async () => {
    await expect(
      CampaignModel.create({
        name: "Bad campaign",
        brand: brandId,
        cities: ["Peshawar"],
      }),
    ).rejects.toThrow();
  });
});
