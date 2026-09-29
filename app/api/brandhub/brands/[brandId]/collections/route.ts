/**
 * A brand's own waste collections.
 *
 * GET reports what has been collected from them; PATCH is the "collect from
 * us too" toggle. A brand that asks us to pick waste up is a consumer of the
 * service as well as a partner in it.
 *
 * The impact figures come from the operations API, which owns collections.
 * Reaching into `collection_stops` from here would couple BrandHub to a
 * schema it does not own and cannot see change — and would put a second
 * answer beside the one the console gives.
 */
import { type NextRequest, NextResponse } from "next/server";
import { findBrandById } from "@/lib/repositories/brandhub";
import {
  listBrandCollectionAccounts,
  setBrandCollectionPin,
  setBrandWantsCollections,
} from "@/lib/repositories/brandCollections";
import { brandImpact } from "@/lib/adminApi";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";

interface Ctx {
  params: Promise<{ brandId: string }>;
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { brandId } = await params;

  const access = await requireModuleAccess(req, "consumer-reporting", "read");
  if (access instanceof NextResponse) return access;
  const scope = await requireBrandScope(access.brandUser, brandId);
  if (scope instanceof NextResponse) return scope;

  const brand = await findBrandById(brandId);
  if (!brand) {
    return NextResponse.json({ error: "Brand not found." }, { status: 404 });
  }

  const accounts = await listBrandCollectionAccounts(brandId);
  const impact = await brandImpact(brandId, {
    from: req.nextUrl.searchParams.get("from") ?? undefined,
    to: req.nextUrl.searchParams.get("to") ?? undefined,
  });

  return NextResponse.json({
    wantsCollections: brand.wantsCollections ?? false,
    accounts,
    /*
     * Null rather than zero when operations cannot be reached.
     *
     * A brand reading "0 kg collected" would believe it. An absent figure is
     * the honest answer to a question we could not ask — the same distinction
     * the app now draws between an empty history and a failed request.
     */
    impact: impact.ok ? impact.data : null,
    impactUnavailable: !impact.ok,
  });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { brandId } = await params;

  // Writing, so a read grant is not enough.
  const access = await requireModuleAccess(req, "consumer-reporting", "write");
  if (access instanceof NextResponse) return access;
  const scope = await requireBrandScope(access.brandUser, brandId);
  if (scope instanceof NextResponse) return scope;

  let body: { wantsCollections?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.wantsCollections !== "boolean") {
    return NextResponse.json(
      { error: "wantsCollections must be true or false." },
      { status: 400 },
    );
  }

  const result = await setBrandWantsCollections({
    brandId,
    wants: body.wantsCollections,
  });
  return NextResponse.json(result);
}

/**
 * Drops the pin on a collection account.
 *
 * Separate from PATCH because it answers a different question: PATCH is
 * whether they want collections at all, this is where the van goes. A brand
 * can opt in today and pin next week.
 */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { brandId } = await params;

  const access = await requireModuleAccess(req, "consumer-reporting", "write");
  if (access instanceof NextResponse) return access;
  const scope = await requireBrandScope(access.brandUser, brandId);
  if (scope instanceof NextResponse) return scope;

  let body: { accountId?: unknown; lat?: unknown; lng?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (typeof body.accountId !== "string" || !body.accountId) {
    return NextResponse.json({ error: "accountId is required." }, { status: 400 });
  }
  // Range-checked here rather than left to PostGIS: ST_MakePoint accepts any
  // pair of numbers quite happily, and a transposed lat/lng lands in the sea.
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return NextResponse.json({ error: "lat must be between -90 and 90." }, { status: 400 });
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return NextResponse.json({ error: "lng must be between -180 and 180." }, { status: 400 });
  }

  try {
    const pinned = await setBrandCollectionPin({
      brandId,
      accountId: body.accountId,
      lat,
      lng,
    });
    return NextResponse.json(pinned);
  } catch {
    return NextResponse.json(
      { error: "No such collection account for this brand." },
      { status: 404 },
    );
  }
}
