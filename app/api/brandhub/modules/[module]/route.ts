import { NextRequest, NextResponse } from "next/server";
import { requireModuleAccess } from "@/lib/requireModuleAccess";
import { isValidModuleId } from "@/lib/modules";

interface RouteParams {
  params: Promise<{ module: string }>;
}

/**
 * Demo routes exercising the full BrandHub RBAC middleware chain for any
 * module in the catalogue: GET requires "read", POST requires "write".
 *
 * Unlike a naive Express version, the module-id check runs before
 * requireModuleAccess() so an unknown module name 404s immediately instead
 * of paying for a JWT verify + org lookup first.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { module: moduleName } = await params;

  if (!isValidModuleId(moduleName)) {
    return NextResponse.json({ error: "Unknown module" }, { status: 404 });
  }

  const auth = await requireModuleAccess(req, moduleName, "read");
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    module: moduleName,
    message: `${moduleName} module — read access confirmed`,
    user: { sub: auth.brandUser.sub, orgRole: auth.brandUser.orgRole },
  });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { module: moduleName } = await params;

  if (!isValidModuleId(moduleName)) {
    return NextResponse.json({ error: "Unknown module" }, { status: 404 });
  }

  const auth = await requireModuleAccess(req, moduleName, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));

  return NextResponse.json({
    module: moduleName,
    message: `${moduleName} module — write access confirmed`,
    received: body,
  });
}
