import { NextRequest, NextResponse } from "next/server";
import {
  createBrand,
  findBrandUserById,
  findBrands,
  isDuplicateKeyError,
  newObjectId,
} from "@/lib/repositories/brandhub";
import { requireBrandAuth } from "@/lib/requireBrandAuth";

/**
 * GET /api/brandhub/brands
 * Lists the caller's org's brands. requireBrandAuth only — no module gate,
 * brand listing is org-level, not a module feature.
 */
export async function GET(req: NextRequest) {
  const auth = requireBrandAuth(req);
  if (auth instanceof NextResponse) return auth;

  const brands = await findBrands({ orgId: auth.brandUser.orgId });

  return NextResponse.json({
    brands: brands.map((b) => ({
      id: b._id,
      brandName: b.brandName,
      companyName: b.companyName,
      logo: b.logo ?? null,
      createdAt: b.createdAt,
    })),
  });
}

/**
 * POST /api/brandhub/brands
 * Creates an additional brand under the caller's org. Owner/admin only —
 * members manage brands they are scoped to, they do not mint new ones.
 *
 * The client supplies only brandName/companyName. `email` and
 * `registrationNumber` carry unique indexes and are schema-required, so both
 * are synthesized from the new brand's `_id`: the email uses the
 * `brand-<id>@brandhub.local` placeholder form that lib/brandEmail.ts on the
 * client already recognises, with the creating user's real address kept in
 * `contactName` so it is not lost. Collecting real values for the remaining
 * placeholders is the same known follow-up as the signup flow.
 */
export async function POST(req: NextRequest) {
  const auth = requireBrandAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { orgRole, orgId, sub } = auth.brandUser;
  if (orgRole !== "owner" && orgRole !== "admin") {
    return NextResponse.json(
      { error: "Only an org owner or admin can create a brand" },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const brandName =
    typeof body.brandName === "string" ? body.brandName.trim() : "";
  const companyName =
    typeof body.companyName === "string" ? body.companyName.trim() : "";

  if (!brandName) {
    return NextResponse.json(
      { error: "brandName is required" },
      { status: 400 },
    );
  }

  // The JWT carries no email, so read the creating user's address for
  // contactName. A token whose user has since been deleted is not a session
  // we should mint records for.
  const creator = await findBrandUserById(sub);
  if (!creator) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const brandId = newObjectId();
  let brand;
  try {
    brand = await createBrand({
      _id: brandId,
      orgId,
      brandName,
      companyName: companyName || brandName,
      email: `brand-${brandId}@brandhub.local`,
      category: "general",
      webLink: "https://example.com",
      appLink: "",
      address: "",
      description: "",
      contactName: creator.email,
      phone: "N/A",
      registrationNumber: `BH-${brandId}`,
    });
  } catch (error: unknown) {
    // Both synthesized keys derive from a fresh id, so a duplicate here is not
    // something the caller can correct by retrying with other input.
    if (isDuplicateKeyError(error)) {
      return NextResponse.json(
        { error: "Could not allocate a unique brand record. Please retry." },
        { status: 409 },
      );
    }
    throw error;
  }

  return NextResponse.json(
    {
      brand: {
        id: brand._id,
        brandName: brand.brandName,
        companyName: brand.companyName,
        logo: brand.logo ?? null,
        createdAt: brand.createdAt,
      },
    },
    { status: 201 },
  );
}
