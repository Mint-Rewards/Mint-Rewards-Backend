/// <reference types="jest" />

import { isCampaignVisibleToCity } from "../lib/campaignVisibility";

describe("isCampaignVisibleToCity", () => {
  it("is visible to anyone when the campaign has no cities", () => {
    expect(isCampaignVisibleToCity({ cities: [] }, "Lahore")).toBe(true);
    expect(isCampaignVisibleToCity({ cities: [] }, null)).toBe(true);
    expect(isCampaignVisibleToCity({ cities: undefined }, "Lahore")).toBe(true);
    expect(isCampaignVisibleToCity({}, null)).toBe(true);
  });

  it("is visible when the user's city is in the campaign's cities", () => {
    expect(isCampaignVisibleToCity({ cities: ["Lahore", "Karachi"] }, "Lahore")).toBe(
      true,
    );
  });

  it("is hidden when the user's city is not in the campaign's cities", () => {
    expect(isCampaignVisibleToCity({ cities: ["Lahore"] }, "Karachi")).toBe(false);
  });

  it("is hidden from a user with no city when the campaign is targeted", () => {
    expect(isCampaignVisibleToCity({ cities: ["Lahore"] }, null)).toBe(false);
    expect(isCampaignVisibleToCity({ cities: ["Lahore"] }, undefined)).toBe(false);
    expect(isCampaignVisibleToCity({ cities: ["Lahore"] }, "")).toBe(false);
  });

  it("matches regardless of case and surrounding whitespace", () => {
    expect(isCampaignVisibleToCity({ cities: ["Lahore"] }, "lahore")).toBe(true);
    expect(isCampaignVisibleToCity({ cities: ["Lahore"] }, " Lahore ")).toBe(true);
    expect(isCampaignVisibleToCity({ cities: [" lahore "] }, "Lahore")).toBe(true);
  });
});
