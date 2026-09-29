/**
 * One premises.
 *
 * Renaming only. A premises is not deleted here, and that is deliberate: the
 * account is the subject of every collection ever made from that address, so
 * removing it would take the brand's own record with it. Retiring one wants a
 * flag and a decision about what the console shows afterwards, which is a
 * bigger change than a rename.
 */
import { type NextRequest, NextResponse } from "next/server";
import { renameBrandCollectionBranch } from "@/lib/repositories/brandCollections";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";

interface Ctx {
  params: Promise<{ brandId: string; accountId: string }>;
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { brandId, accountId } = await params;

  const access = await requireModuleAccess(req, "consumer-reporting", "write");
  if (access instanceof NextResponse) return access;
  const scope = await requireBrandScope(access.brandUser, brandId);
  if (scope instanceof NextResponse) return scope;

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }
  if (body.name.trim().length > 80) {
    return NextResponse.json({ error: "That name is too long." }, { status: 400 });
  }

  try {
    const accounts = await renameBrandCollectionBranch({ brandId, accountId, name: body.name });
    return NextResponse.json({ accounts });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not rename that branch." },
      { status: 400 },
    );
  }
}
