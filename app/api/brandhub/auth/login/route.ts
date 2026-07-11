import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import connectToDatabase from "@/lib/mongodb";
import { BrandModel, BrandUserModel, OrganizationModel } from "@/lib/models";
import { signBrandToken } from "@/lib/brandJwt";
import { MODULE_CATALOGUE, hasActiveSubscription } from "@/lib/modules";

/**
 * POST /api/brandhub/auth/login
 * Body:    { email: string; password: string }
 * Returns: { token, orgId, brands, defaultBrandId }
 *
 * The org's brand list rides in the response body, not the JWT — brand
 * lists change when brands are created/deleted, and baking them into an
 * 8-hour token would go stale until re-login. Brand-level scoping is
 * enforced server-side per request via requireBrandScope.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as {
    email?: string;
    password?: string;
  } | null;

  const { email, password } = body ?? {};

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 },
    );
  }

  await connectToDatabase();

  const normalizedEmail = email.toLowerCase().trim();
  const user = await BrandUserModel.findOne({ email: normalizedEmail });

  // Run bcrypt.compare regardless of whether a user was found so that
  // response timing stays constant and prevents email enumeration.
  const dummyHash =
    "$2b$10$invalidhashfortimingnormalization000000000000000000000";
  const passwordValid = await bcrypt.compare(
    password,
    user?.passwordHash ?? dummyHash,
  );

  if (!user || !passwordValid) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const token = signBrandToken({
    sub: user._id.toString(),
    orgId: user.orgId.toString(),
    orgRole: user.orgRole,
    moduleAccess: user.moduleAccess,
  });

  const brands = await BrandModel.find({ orgId: user.orgId })
    .select("_id brandName companyName logo")
    .lean();

  // Derived fresh at login like `brands` — the frontend's source of truth
  // for subscription-level tab gating. Deliberately not in the JWT.
  const org = await OrganizationModel.findById(user.orgId)
    .select("moduleSubscriptions")
    .lean();
  const subscribedModules = MODULE_CATALOGUE.filter((m) =>
    hasActiveSubscription(org?.moduleSubscriptions ?? [], m.id),
  ).map((m) => m.id);

  return NextResponse.json({
    token,
    orgId: user.orgId.toString(),
    brands: brands.map((b) => ({
      id: b._id.toString(),
      brandName: b.brandName,
      companyName: b.companyName,
      logo: b.logo ?? null,
    })),
    // May legitimately be null (new org, no brands yet) — the frontend
    // routes that to an empty state, not an error.
    defaultBrandId: brands[0]?._id.toString() ?? null,
    subscribedModules,
  });
}
