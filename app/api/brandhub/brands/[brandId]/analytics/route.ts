import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel, CampaignModel, DealModel } from "@/lib/models";
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

// Parse a query-string date. `from` anchors to the start of the day, `to` to
// the end, so a single-day range still spans a full 24h window.
function parseBound(value: string | null, edge: "start" | "end"): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match) {
    const [, y, m, d] = match.map(Number);
    return edge === "start"
      ? new Date(y, m - 1, d, 0, 0, 0, 0)
      : new Date(y, m - 1, d, 23, 59, 59, 999);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// A campaign belongs to the period if its [start, end] window overlaps the
// selected [from, to] window. Missing bounds are treated as open-ended, so a
// campaign with no dates is never excluded by a period filter.
function overlapsPeriod(
  campaign: CampaignDocument,
  from: Date | null,
  to: Date | null,
): boolean {
  if (!from && !to) return true;
  const start = campaign.startDate ? new Date(campaign.startDate) : null;
  const end = campaign.endDate ? new Date(campaign.endDate) : null;
  if (from && end && !Number.isNaN(end.getTime()) && end < from) return false;
  if (to && start && !Number.isNaN(start.getTime()) && start > to) return false;
  return true;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;

    const access = await requireModuleAccess(req, "consumer-reporting", "read");
    if (access instanceof NextResponse) return access;

    const scope = await requireBrandScope(access.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    // Optional period filter. Only campaign-derived metrics are scoped to it —
    // deals and environmental stats have no per-event timestamps in the model,
    // so they remain all-time (the client labels them as such).
    const { searchParams } = new URL(req.url);
    const from = parseBound(searchParams.get("from"), "start");
    const to = parseBound(searchParams.get("to"), "end");
    const periodApplied = Boolean(from || to);

    const [allCampaigns, deals, brand] = await Promise.all([
      CampaignModel.find({ brand: brandId })
        .sort({ _id: -1 })
        .lean<CampaignDocument[]>(),
      DealModel.find({ brand: brandId }).select("status").lean(),
      BrandModel.findById(brandId).select("environmentalStats").lean(),
    ]);

    const campaigns = periodApplied
      ? allCampaigns.filter((c) => overlapsPeriod(c, from, to))
      : allCampaigns;

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

    const dealStats = {
      total: deals.length,
      active: deals.filter((deal) => deal.status === "active").length,
      inactive: deals.filter((deal) => deal.status === "inactive").length,
      expired: deals.filter((deal) => deal.status === "expired").length,
    };

    return Response.json({
      success: true,
      analytics: {
        period: periodApplied
          ? {
              from: from ? from.toISOString() : null,
              to: to ? to.toISOString() : null,
            }
          : null,
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
        dealStats,
        ...(brand?.environmentalStats
          ? { environmental: brand.environmentalStats }
          : {}),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
