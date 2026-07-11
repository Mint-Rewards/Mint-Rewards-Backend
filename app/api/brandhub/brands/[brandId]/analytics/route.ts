import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { CampaignModel } from "@/lib/models";
import type { CampaignDocument } from "@/lib/types";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";
import { isCampaignActive } from "@/lib/campaignDates";

interface RouteParams {
  params: Promise<{ brandId: string }>;
}

function isActive(campaign: CampaignDocument): boolean {
  if (campaign.status !== "APPROVED") return false;
  return isCampaignActive(campaign);
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;

    const access = await requireModuleAccess(req, "consumer-reporting", "read");
    if (access instanceof NextResponse) return access;

    const scope = await requireBrandScope(access.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    const campaigns = await CampaignModel.find({ brand: brandId })
      .sort({ _id: -1 })
      .lean<CampaignDocument[]>();

    // Campaign status breakdown
    const byStatus: Record<string, number> = {};
    for (const c of campaigns) {
      byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    }

    // Redemption totals across all campaigns
    const totalRedemptions = campaigns.reduce(
      (sum, c) => sum + (c.users?.length ?? 0),
      0,
    );

    // Unique users who redeemed at least one campaign
    const uniqueUserSet = new Set<string>();
    for (const c of campaigns) {
      for (const uid of c.users ?? []) {
        uniqueUserSet.add(uid.toString());
      }
    }

    // Active campaigns (APPROVED + within date range)
    const activeCampaigns = campaigns.filter(isActive);

    // Per-campaign list sorted by redemptions descending
    const campaignList = campaigns.map((c) => ({
      id: String(c._id),
      name: c.name,
      status: c.status,
      startDate: c.startDate,
      endDate: c.endDate,
      redemptions: c.users?.length ?? 0,
      campaignType: c.campaignType ?? null,
      badge: c.badge ?? null,
      subtitle: c.subtitle ?? null,
      backgroundColor: c.backgroundColor ?? null,
    }));
    campaignList.sort((a, b) => b.redemptions - a.redemptions);

    return Response.json({
      success: true,
      analytics: {
        summary: {
          totalCampaigns: campaigns.length,
          activeCampaigns: activeCampaigns.length,
          totalRedemptions,
          uniqueUsers: uniqueUserSet.size,
        },
        campaigns: {
          byStatus,
          active: campaignList.filter(
            (c) => c.status === "APPROVED" && isCampaignActive(c),
          ),
          list: campaignList,
        },
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
