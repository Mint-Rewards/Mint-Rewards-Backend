import { type NextRequest, NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel, CampaignModel, DealModel } from "@/lib/models";
import type {
  CampaignDocument,
  DealDocument,
  EnvironmentalPeriod,
} from "@/lib/types";
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

// An item belongs to the period if its [start, end] window overlaps the
// selected [from, to] window. Missing bounds are treated as open-ended, so an
// item with no dates is never excluded by a period filter. Shared by
// campaigns and deals — both models carry startDate/endDate.
function overlapsPeriod(
  item: { startDate?: string | null; endDate?: string | null },
  from: Date | null,
  to: Date | null,
): boolean {
  if (!from && !to) return true;
  const start = item.startDate ? new Date(item.startDate) : null;
  const end = item.endDate ? new Date(item.endDate) : null;
  if (from && end && !Number.isNaN(end.getTime()) && end < from) return false;
  if (to && start && !Number.isNaN(start.getTime()) && start > to) return false;
  return true;
}

// Sums the dated impact buckets overlapping the requested window.
//
// Buckets are counted WHOLE, never pro-rated: a month's tonnage is a measured
// figure, and slicing it by the fraction of days the caller happened to select
// would invent a number that never existed. Because of that, the summed total
// can cover more calendar time than was asked for — so the actual span of the
// buckets included is returned as `coverage`, and the client shows it. An ESG
// figure has to say which days it covers.
function aggregatePeriods(
  buckets: EnvironmentalPeriod[],
  from: Date | null,
  to: Date | null,
) {
  const included = buckets.filter((b) =>
    overlapsPeriod({ startDate: b.periodStart, endDate: b.periodEnd }, from, to),
  );
  if (included.length === 0) {
    return {
      totalWasteKg: 0,
      co2AvoidedKg: 0,
      materialBreakdown: [],
      periodScoped: true,
      coverage: null,
    };
  }

  const byMaterial = new Map<string, number>();
  let totalWasteKg = 0;
  let co2AvoidedKg = 0;
  for (const bucket of included) {
    totalWasteKg += bucket.totalWasteKg;
    co2AvoidedKg += bucket.co2AvoidedKg;
    for (const entry of bucket.materialBreakdown ?? []) {
      byMaterial.set(
        entry.material,
        (byMaterial.get(entry.material) ?? 0) + entry.weightKg,
      );
    }
  }

  const starts = included.map((b) => b.periodStart).sort();
  const ends = included.map((b) => b.periodEnd).sort();

  return {
    totalWasteKg,
    co2AvoidedKg,
    // Descending, so the dominant material leads the client's breakdown list.
    materialBreakdown: [...byMaterial.entries()]
      .map(([material, weightKg]) => ({ material, weightKg }))
      .sort((a, b) => b.weightKg - a.weightKg),
    periodScoped: true,
    coverage: { from: starts[0], to: ends[ends.length - 1] },
  };
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { brandId } = await params;

    const access = await requireModuleAccess(req, "consumer-reporting", "read");
    if (access instanceof NextResponse) return access;

    const scope = await requireBrandScope(access.brandUser, brandId);
    if (scope instanceof NextResponse) return scope;

    await connectToDatabase();

    // Optional period filter. Campaigns and deals both carry startDate/endDate
    // so both are scoped to it; environmental stats have no per-event
    // timestamps in the model, so those remain all-time (the client labels
    // them as such).
    const { searchParams } = new URL(req.url);
    const from = parseBound(searchParams.get("from"), "start");
    const to = parseBound(searchParams.get("to"), "end");
    const periodApplied = Boolean(from || to);

    const [allCampaigns, allDeals, brand] = await Promise.all([
      CampaignModel.find({ brand: brandId })
        .sort({ _id: -1 })
        .lean<CampaignDocument[]>(),
      DealModel.find({ brand: brandId })
        .select("status startDate endDate")
        .lean<DealDocument[]>(),
      BrandModel.findById(brandId)
        .select("environmentalStats environmentalPeriods")
        .lean(),
    ]);

    const campaigns = periodApplied
      ? allCampaigns.filter((c) => overlapsPeriod(c, from, to))
      : allCampaigns;

    const deals = periodApplied
      ? allDeals.filter((d) => overlapsPeriod(d, from, to))
      : allDeals;

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
        // Dated buckets win when present; otherwise fall back to the legacy
        // cumulative snapshot, flagged periodScoped:false so the client can
        // label it all-time rather than implying it followed the picker.
        ...(brand?.environmentalPeriods?.length
          ? {
              environmental: aggregatePeriods(
                brand.environmentalPeriods,
                from,
                to,
              ),
            }
          : brand?.environmentalStats
            ? {
                environmental: {
                  ...brand.environmentalStats,
                  periodScoped: false,
                  coverage: null,
                },
              }
            : {}),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ success: false, message }, { status: 500 });
  }
}
