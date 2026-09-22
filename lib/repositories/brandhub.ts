/**
 * Organisations, their logins, and their brands — on Postgres.
 *
 * Returns documents shaped the way the Mongo ones were, `_id` and all, rather
 * than raw rows. Two reasons, both about not breaking things that are not part
 * of this change: several responses hand `_id` to clients that merge on it,
 * and callers that sorted by `{ _id: -1 }` keep working because an ObjectId's
 * hex is lexicographically ordered by the timestamp it starts with, so
 * `ORDER BY id DESC` on text is the same order.
 *
 * The three tables move together. Signup writes all of them in one
 * transaction, which is why they could not be ported one at a time — see
 * lib/db/schema/brandhub.ts.
 */
import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/postgres";
import {
  brandUsers,
  brands,
  organizations,
  type BrandRow,
  type BrandUserRow,
  type OrganizationRow,
} from "@/lib/db/schema";

type Db = ReturnType<typeof getDb>;
/** The pool, or a transaction. Callers pass one without knowing which. */
export type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * A unique-constraint violation.
 *
 * Routes used to test Mongo's `error.code === 11000` inline. Postgres says
 * 23505 instead, so the check moves in here and the routes ask a question
 * about their domain rather than about a driver.
 */
export class DuplicateKeyError extends Error {
  constructor(public readonly constraint?: string) {
    super(
      constraint
        ? `A record already exists violating ${constraint}`
        : "A record with these details already exists",
    );
    this.name = "DuplicateKeyError";
  }
}

/**
 * The Postgres error the driver actually raised.
 *
 * Drizzle wraps a failed query in a DrizzleQueryError and hangs the driver's
 * error off `cause`, so the SQLSTATE is never on the error handed to a caller.
 * Reading only the top level turns every duplicate email into a 500 instead of
 * a 409 — which is exactly what this missed until a test went looking.
 */
function driverError(error: unknown): { code?: string; constraint?: string } {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    if ("code" in current) return current as { code?: string; constraint?: string };
    if (!("cause" in current)) break;
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}

export function isDuplicateKeyError(error: unknown): boolean {
  if (error instanceof DuplicateKeyError) return true;
  return driverError(error).code === "23505";
}

/** Rethrows a unique violation as something the domain can catch. */
async function translating<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new DuplicateKeyError(driverError(error).constraint);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Document shapes. Field names are Mongo's, so callers need not be rewritten.
// ---------------------------------------------------------------------------

export interface OrganizationDoc {
  _id: string;
  name: string;
  plan: string;
  moduleSubscriptions: unknown[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BrandUserDoc {
  _id: string;
  orgId: string;
  email: string;
  passwordHash: string;
  orgRole: string;
  moduleAccess: unknown[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BrandDoc {
  _id: string;
  orgId: string | null;
  legacyBrandId: string | null;
  companyName: string;
  brandName: string;
  email: string;
  logo: string | null;
  themeImage: string | null;
  category: string;
  description: string;
  address: string;
  webLink: string;
  appLink: string;
  contactName: string;
  phone: string;
  registrationNumber: string;
  domain: string;
  themeColor: string;
  status: string;
  role: string;
  emailVerified: boolean;
  verificationToken: string | null;
  environmentalStats: unknown;
  environmentalPeriods: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

function toOrganization(row: OrganizationRow): OrganizationDoc {
  return {
    _id: row.id,
    name: row.name,
    plan: row.plan,
    moduleSubscriptions: asArray(row.moduleSubscriptions),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toBrandUser(row: BrandUserRow): BrandUserDoc {
  return {
    _id: row.id,
    orgId: row.orgId,
    email: row.email,
    passwordHash: row.passwordHash,
    orgRole: row.orgRole,
    moduleAccess: asArray(row.moduleAccess),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toBrand(row: BrandRow): BrandDoc {
  return {
    _id: row.id,
    orgId: row.orgId,
    legacyBrandId: row.legacyBrandId,
    companyName: row.companyName,
    brandName: row.brandName,
    email: row.email,
    logo: row.logo,
    themeImage: row.themeImage,
    category: row.category,
    description: row.description,
    address: row.address,
    webLink: row.webLink,
    appLink: row.appLink,
    contactName: row.contactName,
    phone: row.phone,
    registrationNumber: row.registrationNumber,
    domain: row.domain,
    themeColor: row.themeColor,
    status: row.status,
    role: row.role,
    emailVerified: row.emailVerified,
    verificationToken: row.verificationToken,
    environmentalStats: row.environmentalStats,
    environmentalPeriods: row.environmentalPeriods,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A fresh 24-character ObjectId hex.
 *
 * New rows keep the old id shape rather than switching to a uuid or a serial.
 * Campaign and Deal still hold brand ids in Mongo, and BrandHub JWTs carry
 * orgId, so the two stores have to agree on what an id looks like for as long
 * as either of them is authoritative for anything.
 */
export function newObjectId(): string {
  const seconds = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, "0");
  const random = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return seconds + random;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Runs `work` inside one transaction.
 *
 * Signup needs this. Creating an organisation, its owner and its first brand
 * separately once left people with a real org and login but no brand, after a
 * 409 on a duplicate brand email — so all three commit together or none do.
 */
export async function inTransaction<T>(
  work: (tx: Executor) => Promise<T>,
): Promise<T> {
  return translating(() =>
    getDb().transaction((tx) => work(tx as Executor)),
  );
}

const exec = (tx?: Executor): Executor => tx ?? getDb();

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export async function findOrganizationById(
  id: string,
  tx?: Executor,
): Promise<OrganizationDoc | null> {
  const rows = await exec(tx)
    .select()
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  return rows[0] ? toOrganization(rows[0]) : null;
}

export async function createOrganization(
  input: { name: string; moduleSubscriptions?: unknown[]; plan?: string },
  tx?: Executor,
): Promise<OrganizationDoc> {
  return translating(async () => {
    const rows = await exec(tx)
      .insert(organizations)
      .values({
        id: newObjectId(),
        name: input.name,
        plan: input.plan ?? "starter",
        moduleSubscriptions: input.moduleSubscriptions ?? [],
      })
      .returning();
    return toOrganization(rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Brand users
// ---------------------------------------------------------------------------

export async function findBrandUserById(
  id: string,
  tx?: Executor,
): Promise<BrandUserDoc | null> {
  const rows = await exec(tx)
    .select()
    .from(brandUsers)
    .where(eq(brandUsers.id, id))
    .limit(1);
  return rows[0] ? toBrandUser(rows[0]) : null;
}

export async function findBrandUserByEmail(
  email: string,
  tx?: Executor,
): Promise<BrandUserDoc | null> {
  const rows = await exec(tx)
    .select()
    .from(brandUsers)
    .where(eq(brandUsers.email, email.toLowerCase()))
    .limit(1);
  return rows[0] ? toBrandUser(rows[0]) : null;
}

export async function createBrandUser(
  input: {
    orgId: string;
    email: string;
    passwordHash: string;
    orgRole: string;
    moduleAccess?: unknown[];
  },
  tx?: Executor,
): Promise<BrandUserDoc> {
  return translating(async () => {
    const rows = await exec(tx)
      .insert(brandUsers)
      .values({
        id: newObjectId(),
        orgId: input.orgId,
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        orgRole: input.orgRole,
        moduleAccess: input.moduleAccess ?? [],
      })
      .returning();
    return toBrandUser(rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

export interface BrandFilter {
  orgId?: string;
  status?: string;
  /** Only rows paired with a legacy document. */
  hasLegacyBrandId?: boolean;
}

export async function findBrandById(
  id: string,
  tx?: Executor,
): Promise<BrandDoc | null> {
  // An id that is not a 24-hex string cannot match anything, and asking is
  // cheaper than a round trip. Mongo threw a CastError here; returning null is
  // the answer every caller already handles.
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return null;
  const rows = await exec(tx)
    .select()
    .from(brands)
    .where(eq(brands.id, id))
    .limit(1);
  return rows[0] ? toBrand(rows[0]) : null;
}

/**
 * Brands matching a filter, newest first.
 *
 * The order is `id DESC`, which is what `sort({ _id: -1 })` meant: an
 * ObjectId begins with a big-endian timestamp, so its hex sorts
 * chronologically as text.
 */
export async function findBrands(
  filter: BrandFilter = {},
  tx?: Executor,
): Promise<BrandDoc[]> {
  const conditions = [];
  if (filter.orgId) conditions.push(eq(brands.orgId, filter.orgId));
  if (filter.status) conditions.push(eq(brands.status, filter.status));
  if (filter.hasLegacyBrandId) conditions.push(isNotNull(brands.legacyBrandId));

  const rows = await exec(tx)
    .select()
    .from(brands)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(brands.id));
  return rows.map(toBrand);
}

/** The signup collision check: either field already taken. */
export async function findBrandByEmailOrRegistration(
  email: string,
  registrationNumber: string,
  tx?: Executor,
): Promise<BrandDoc | null> {
  const rows = await exec(tx)
    .select()
    .from(brands)
    .where(
      or(
        eq(brands.email, email.toLowerCase()),
        eq(brands.registrationNumber, registrationNumber),
      ),
    )
    .limit(1);
  return rows[0] ? toBrand(rows[0]) : null;
}

export type NewBrand = Omit<
  Partial<BrandDoc>,
  "_id" | "createdAt" | "updatedAt"
> & {
  companyName: string;
  brandName: string;
  email: string;
  category: string;
  webLink: string;
  contactName: string;
  phone: string;
  registrationNumber: string;
};

export async function createBrand(
  input: NewBrand & { _id?: string },
  tx?: Executor,
): Promise<BrandDoc> {
  return translating(async () => {
    const rows = await exec(tx)
      .insert(brands)
      .values({
        id: input._id ?? newObjectId(),
        orgId: input.orgId ?? null,
        legacyBrandId: input.legacyBrandId ?? null,
        companyName: input.companyName,
        brandName: input.brandName,
        email: input.email.toLowerCase(),
        logo: input.logo ?? null,
        themeImage: input.themeImage ?? null,
        category: input.category,
        description: input.description ?? "",
        address: input.address ?? "",
        webLink: input.webLink,
        appLink: input.appLink ?? "",
        contactName: input.contactName,
        phone: input.phone,
        registrationNumber: input.registrationNumber,
        domain: input.domain ?? "",
        themeColor: input.themeColor ?? "#3B82F6",
        status: input.status ?? "PENDING",
        role: input.role ?? "BRAND",
        emailVerified: input.emailVerified ?? false,
        verificationToken: input.verificationToken ?? null,
        environmentalStats: input.environmentalStats ?? null,
        environmentalPeriods: input.environmentalPeriods ?? null,
      })
      .returning();
    return toBrand(rows[0]);
  });
}

/**
 * Applies a partial update and returns the row as it now stands.
 *
 * Mongo's `{ new: true }`, in other words. `updated_at` is set here rather
 * than by a trigger so that the value is the same one the caller is handed
 * back.
 */
export async function updateBrand(
  id: string,
  patch: Partial<Omit<BrandDoc, "_id" | "createdAt" | "updatedAt">>,
  tx?: Executor,
): Promise<BrandDoc | null> {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return null;
  const values: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    values[key] = key === "email" ? String(value).toLowerCase() : value;
  }

  return translating(async () => {
    const rows = await exec(tx)
      .update(brands)
      .set(values)
      .where(eq(brands.id, id))
      .returning();
    return rows[0] ? toBrand(rows[0]) : null;
  });
}

/** How many brands exist at all. Used by health and admin summaries. */
export async function countBrands(tx?: Executor): Promise<number> {
  const rows = await exec(tx)
    .select({ n: sql<number>`count(*)::int` })
    .from(brands);
  return rows[0]?.n ?? 0;
}
