/**
 * A brand's premises.
 *
 * A brand with four shops has four places a van goes to, and the collection
 * pipeline has always been able to express that — a premises is an account
 * under the brand's id, and the directory, zone containment, routing and the
 * ESG roll-up all work per account already. What was missing was a way to
 * create the second one.
 *
 * Separate route from `../` because it answers a different question: that one
 * is whether the brand wants collections at all and where the van goes, this
 * is which places exist.
 */
import { type NextRequest, NextResponse } from "next/server";
import { addBrandCollectionBranch } from "@/lib/repositories/brandCollections";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { requireBrandScope } from "@/lib/requireBrandScope";

interface Ctx {
  params: Promise<{ brandId: string }>;
}

/** Names a new premises. It starts unpinned; the pin is PUT on the parent. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { brandId } = await params;

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
    return NextResponse.json(
      { error: "That name is too long." },
      { status: 400 },
    );
  }

  try {
    const accounts = await addBrandCollectionBranch({
      brandId,
      name: body.name,
    });
    return NextResponse.json({ accounts }, { status: 201 });
  } catch (error) {
    /*
     * The repository's refusals are ones the person can act on — a duplicate
     * name, or the cap — so its words are passed through rather than
     * flattened into "something went wrong".
     */
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not add that branch.",
      },
      { status: 400 },
    );
  }
}
