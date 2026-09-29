/**
 * Consumer accounts on Postgres.
 *
 * COLUMNS ARE PROJECTED EXPLICITLY, NEVER `SELECT *`.
 *
 * `password`, `password_reset` and `email_verification` hold a bcrypt hash and
 * two OTP hashes. In Mongoose the last two carried `select: false`, so an
 * ordinary read could not return them and no route had to remember to exclude
 * them. Postgres has no equivalent, so the guarantee is rebuilt here: the
 * default projection omits all three, and a caller that needs one asks for it
 * by name. A `.select()` without a column list anywhere below undoes that for
 * every caller at once.
 *
 * The guarded updates at the bottom — the bonus, the referral, the OTPs — are
 * the ones where a lost race costs points or lets a burnt code be reused. Each
 * is a single statement whose WHERE clause carries the guard, so a second
 * concurrent call matches nothing rather than doing the work twice.
 */
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/postgres";
import { users } from "@/lib/db/schema";
import type { Executor } from "@/lib/repositories/brandhub";
import type { User } from "@/lib/types";

const exec = (tx?: Executor): Executor => tx ?? getDb();

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * The domain's own shapes, not new ones.
 *
 * evaluateLocation, the completion evaluator and their tests all take these
 * types; a parallel set here would mean every caller converting between two
 * descriptions of the same thing.
 */
export type UserLocation = NonNullable<User["location"]>;
export type StructuredAddress = NonNullable<User["structuredAddress"]>;
export type LocationVerification = NonNullable<User["locationVerification"]>;

export interface OtpBlock {
  otpHash?: string;
  expiresAt?: string;
  attempts?: number;
  lastSentAt?: string;
}

/** What an ordinary read returns. No hashes of any kind. */
export interface UserDoc {
  _id: string;
  userName: string;
  email: string;
  mintId: string;
  role: string;
  phone: string;
  avatar: string;
  address: string;
  province: string;
  city: string;
  town: string;
  townOther: string;
  subArea: string;
  subAreaOther: string;
  latitude: string;
  longitude: string;
  deviceToken: string;
  points: number;
  totalCollections: string;
  totalWasteCollected: string;
  referrals: string[];
  referralRewardGranted: boolean;
  /**
   * The domain shape, not the storage one.
   *
   * Stored as a geography column plus three scalars, but presented as the
   * nested object the rest of the codebase already reads — evaluateLocation,
   * the completion evaluator and their tests all take `user.location`, and
   * they should not have to learn how this table is laid out.
   */
  location?: UserLocation;
  structuredAddress?: StructuredAddress;
  locationVerification?: LocationVerification;
  locationVersion: number;
  locationCompletedAt?: Date;
  /**
   * Omitted rather than null when unset, like the other optional fields here.
   *
   * It matters for these three: absence is the meaning. An unset grant stamp
   * is what "not paid" is, and callers test it for truthiness or for being
   * undefined — a null would satisfy the first and quietly fail the second.
   */
  profileBonusWindowStartedAt?: Date;
  profileBonusGrantedAt?: Date;
  profileBonusPoints?: number;
  pickupHistory: unknown[];
  created: Date;
  firstTimeLogin: boolean;
  emailVerified: boolean;
  appleId?: string;
}

/**
 * The default projection.
 *
 * Every column except the three that hold hashes. Adding a column to the
 * table does not add it here, which is the intended direction: a new secret
 * is excluded until somebody decides otherwise.
 */
const PUBLIC = {
  id: users.id,
  userName: users.userName,
  email: users.email,
  mintId: users.mintId,
  role: users.role,
  phone: users.phone,
  avatar: users.avatar,
  address: users.address,
  province: users.province,
  city: users.city,
  town: users.town,
  townOther: users.townOther,
  subArea: users.subArea,
  subAreaOther: users.subAreaOther,
  latitude: users.latitude,
  longitude: users.longitude,
  deviceToken: users.deviceToken,
  points: users.points,
  totalCollections: users.totalCollections,
  totalWasteCollected: users.totalWasteCollected,
  referrals: users.referrals,
  referralRewardGranted: users.referralRewardGranted,
  // geography is not readable as text without help; ST_X/ST_Y give the pair
  // back in the [lng, lat] order the rest of the system uses.
  lng: sql<number | null>`ST_X(${users.geog}::geometry)`,
  lat: sql<number | null>`ST_Y(${users.geog}::geometry)`,
  locationPrecision: users.locationPrecision,
  locationSource: users.locationSource,
  locationAccuracyMeters: users.locationAccuracyMeters,
  locationCapturedAt: users.locationCapturedAt,
  structuredAddress: users.structuredAddress,
  locationVerification: users.locationVerification,
  locationVersion: users.locationVersion,
  locationCompletedAt: users.locationCompletedAt,
  profileBonusWindowStartedAt: users.profileBonusWindowStartedAt,
  profileBonusGrantedAt: users.profileBonusGrantedAt,
  profileBonusPoints: users.profileBonusPoints,
  pickupHistory: users.pickupHistory,
  created: users.created,
  firstTimeLogin: users.firstTimeLogin,
  emailVerified: users.emailVerified,
  appleId: users.appleId,
} as const;

type PublicRow = {
  [K in keyof typeof PUBLIC]: unknown;
};

function toUser(row: PublicRow): UserDoc {
  const lng = row.lng as number | null;
  const lat = row.lat as number | null;
  return {
    _id: row.id as string,
    userName: row.userName as string,
    email: row.email as string,
    mintId: row.mintId as string,
    role: row.role as string,
    phone: row.phone as string,
    avatar: row.avatar as string,
    address: row.address as string,
    province: row.province as string,
    city: row.city as string,
    town: row.town as string,
    townOther: row.townOther as string,
    subArea: row.subArea as string,
    subAreaOther: row.subAreaOther as string,
    latitude: row.latitude as string,
    longitude: row.longitude as string,
    deviceToken: row.deviceToken as string,
    points: row.points as number,
    totalCollections: row.totalCollections as string,
    totalWasteCollected: row.totalWasteCollected as string,
    referrals: (row.referrals as string[]) ?? [],
    referralRewardGranted: row.referralRewardGranted as boolean,
    ...(typeof lng === "number" && typeof lat === "number"
      ? {
          location: {
            type: "Point" as const,
            coordinates: [lng, lat] as [number, number],
            ...(row.locationSource
              ? { source: row.locationSource as UserLocation["source"] }
              : {}),
            ...(row.locationPrecision
              ? { precision: row.locationPrecision as UserLocation["precision"] }
              : {}),
            ...(row.locationAccuracyMeters !== null
              ? { accuracyMeters: row.locationAccuracyMeters as number }
              : {}),
            ...(row.locationCapturedAt
              ? { capturedAt: row.locationCapturedAt as Date }
              : {}),
          },
        }
      : {}),
    ...(row.structuredAddress
      ? { structuredAddress: row.structuredAddress as StructuredAddress }
      : {}),
    ...(row.locationVerification
      ? {
          locationVerification:
            row.locationVerification as LocationVerification,
        }
      : {}),
    locationVersion: row.locationVersion as number,
    ...(row.locationCompletedAt
      ? { locationCompletedAt: row.locationCompletedAt as Date }
      : {}),
    ...(row.profileBonusWindowStartedAt
      ? { profileBonusWindowStartedAt: row.profileBonusWindowStartedAt as Date }
      : {}),
    ...(row.profileBonusGrantedAt
      ? { profileBonusGrantedAt: row.profileBonusGrantedAt as Date }
      : {}),
    ...(row.profileBonusPoints !== null
      ? { profileBonusPoints: row.profileBonusPoints as number }
      : {}),
    pickupHistory: (row.pickupHistory as unknown[]) ?? [],
    created: row.created as Date,
    firstTimeLogin: row.firstTimeLogin as boolean,
    emailVerified: row.emailVerified as boolean,
    ...(row.appleId ? { appleId: row.appleId as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function findUserById(
  id: string,
  tx?: Executor,
): Promise<UserDoc | null> {
  if (!OBJECT_ID.test(id)) return null;
  const rows = await exec(tx)
    .select(PUBLIC)
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUserByEmail(
  email: string,
  tx?: Executor,
): Promise<UserDoc | null> {
  const rows = await exec(tx)
    .select(PUBLIC)
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUserByMintId(
  mintId: string,
  tx?: Executor,
): Promise<UserDoc | null> {
  const rows = await exec(tx)
    .select(PUBLIC)
    .from(users)
    .where(eq(users.mintId, mintId))
    .limit(1);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUserByAppleId(
  appleId: string,
  tx?: Executor,
): Promise<UserDoc | null> {
  const rows = await exec(tx)
    .select(PUBLIC)
    .from(users)
    .where(eq(users.appleId, appleId))
    .limit(1);
  return rows[0] ? toUser(rows[0]) : null;
}

/**
 * The login read, and the only one that returns the password hash.
 *
 * Separate from findUserByEmail so that reaching for the hash is a visible
 * choice at the call site rather than something every read carries.
 */
export async function findUserByEmailForLogin(
  email: string,
  tx?: Executor,
): Promise<(UserDoc & { password: string }) | null> {
  const rows = await exec(tx)
    .select({ ...PUBLIC, password: users.password })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (!rows[0]) return null;
  return { ...toUser(rows[0]), password: rows[0].password as string };
}

/** The OTP blocks, for the reset and verification flows only. */
export async function findUserByEmailWithOtp(
  email: string,
  which: "passwordReset" | "emailVerification",
  tx?: Executor,
): Promise<(UserDoc & { otp: OtpBlock | null }) | null> {
  const column =
    which === "passwordReset" ? users.passwordReset : users.emailVerification;
  const rows = await exec(tx)
    .select({ ...PUBLIC, otp: column })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (!rows[0]) return null;
  return { ...toUser(rows[0]), otp: (rows[0].otp as OtpBlock | null) ?? null };
}

export async function countUsers(tx?: Executor): Promise<number> {
  const rows = await exec(tx)
    .select({ n: sql<number>`count(*)::int` })
    .from(users);
  return rows[0]?.n ?? 0;
}

/** Everyone who has referred this address. */
export async function findUserByReferral(
  email: string,
  tx?: Executor,
): Promise<UserDoc | null> {
  const rows = await exec(tx)
    .select(PUBLIC)
    .from(users)
    .where(sql`${email.toLowerCase()} = ANY(${users.referrals})`)
    .limit(1);
  return rows[0] ? toUser(rows[0]) : null;
}

/**
 * Anyone who already holds one of these addresses — as their own, or in their
 * referrals.
 *
 * One round trip answers both questions the invite path asks: which addresses
 * belong to registered accounts, and which have already been invited by
 * somebody. `email` is unique and indexed; `referrals` is a text[] and the
 * ANY() test can use a GIN index if one is ever needed.
 */
export async function findUsersHoldingEmails(
  emails: readonly string[],
  tx?: Executor,
): Promise<UserDoc[]> {
  const wanted = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (wanted.length === 0) return [];
  const rows = await exec(tx)
    .select(PUBLIC)
    .from(users)
    .where(
      sql`${users.email} = ANY(${sql.param(wanted)}::text[])
          OR ${users.referrals} && ${sql.param(wanted)}::text[]`,
    );
  return rows.map(toUser);
}

/** Accounts matching any of these addresses, for the referral sweep. */
export async function findUsersByEmails(
  emails: readonly string[],
  tx?: Executor,
): Promise<UserDoc[]> {
  const wanted = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (wanted.length === 0) return [];
  const rows = await exec(tx)
    .select(PUBLIC)
    .from(users)
    .where(sql`${users.email} = ANY(${sql.param(wanted)}::text[])`);
  return rows.map(toUser);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface NewUser {
  _id?: string;
  userName: string;
  email: string;
  password: string;
  mintId: string;
  phone?: string;
  avatar?: string;
  emailVerified?: boolean;
  appleId?: string | null;
  role?: string;
}

export async function createUser(
  input: NewUser,
  tx?: Executor,
): Promise<UserDoc> {
  const { newObjectId } = await import("@/lib/repositories/brandhub");
  const id = input._id ?? newObjectId();
  await exec(tx)
    .insert(users)
    .values({
      id,
      userName: input.userName,
      email: input.email.toLowerCase(),
      password: input.password,
      mintId: input.mintId,
      phone: input.phone ?? "",
      avatar: input.avatar ?? "",
      emailVerified: input.emailVerified ?? false,
      appleId: input.appleId ?? null,
      role: input.role ?? "MEMBER",
    });
  const created = await findUserById(id, tx);
  if (!created) throw new Error("User vanished immediately after insert");
  return created;
}

/** Columns a caller may set. The three hash columns are not among them. */
export type UserPatch = Partial<
  Pick<
    UserDoc,
    | "userName"
    | "phone"
    | "avatar"
    | "address"
    | "province"
    | "city"
    | "town"
    | "townOther"
    | "subArea"
    | "subAreaOther"
    | "latitude"
    | "longitude"
    | "deviceToken"
    | "points"
    | "totalCollections"
    | "totalWasteCollected"
    | "referrals"
    | "locationVersion"
    | "locationCompletedAt"
    | "emailVerified"
    | "firstTimeLogin"
    | "appleId"
    | "pickupHistory"
  >
> & {
  /**
   * The nested shape on the way in too. Coordinates go through ST_MakePoint;
   * passing null clears the geography and the three scalars beside it, so a
   * cleared pin does not leave a stale precision behind claiming the row is
   * routable.
   */
  location?: UserLocation | null;
  structuredAddress?: StructuredAddress;
  locationVerification?: LocationVerification;
};

/**
 * Accepts Mongo's dotted paths as well as whole fields.
 *
 * `PATCH /api/users/location` and `PUT /api/users/update-profile` both build
 * their writes as `structuredAddress.<key>` and `location.<key>`, because in
 * Mongo that is what sets one key without disturbing its siblings. Those
 * semantics are carefully tested — writing `areaOther` must clear `areaId`
 * and leave `cityId` alone — so the translation lives here rather than in two
 * routes whose logic would otherwise have to be rewritten and re-proven.
 *
 * `structuredAddress.*` becomes a jsonb merge, which preserves the keys it
 * does not mention. `location.*` becomes the scalar columns and the geography
 * beside them.
 */
export type DottedPatch = UserPatch & Record<string, unknown>;

export async function updateUser(
  id: string,
  patch: DottedPatch,
  tx?: Executor,
): Promise<UserDoc | null> {
  if (!OBJECT_ID.test(id)) return null;
  const values: Record<string, unknown> = {};
  const structuredPatch: Record<string, unknown> = {};
  const verificationPatch: Record<string, unknown> = {};
  const locationPatch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (key === "location" || value === undefined) continue;
    if (key.startsWith("structuredAddress.")) {
      structuredPatch[key.slice("structuredAddress.".length)] = value;
      continue;
    }
    if (key.startsWith("locationVerification.")) {
      verificationPatch[key.slice("locationVerification.".length)] = value;
      continue;
    }
    if (key.startsWith("location.")) {
      locationPatch[key.slice("location.".length)] = value;
      continue;
    }
    values[key] = value;
  }

  if (Object.keys(structuredPatch).length > 0) {
    // `||` merges right over left, so unmentioned keys survive — which is
    // exactly what dot notation did.
    values.structuredAddress = sql`COALESCE(${users.structuredAddress}, '{}'::jsonb) || ${JSON.stringify(structuredPatch)}::jsonb`;
  }

  if (Object.keys(verificationPatch).length > 0) {
    // Merged, never replaced. Every row where geocodedAreaRaw and
    // selectedAreaId disagree is a labelled geocoder failure, and a write that
    // mentions one must not drop the other.
    values.locationVerification = sql`COALESCE(${users.locationVerification}, '{}'::jsonb) || ${JSON.stringify(verificationPatch)}::jsonb`;
  }

  if (Object.keys(locationPatch).length > 0) {
    const pair = locationPatch.coordinates;
    if (Array.isArray(pair) && pair.length === 2) {
      values.geog = sql`ST_SetSRID(ST_MakePoint(${Number(pair[0])}, ${Number(pair[1])}), 4326)::geography`;
    }
    // `type` is always "Point" and has no column — the geography carries it.
    if ("source" in locationPatch) values.locationSource = locationPatch.source;
    if ("precision" in locationPatch) {
      values.locationPrecision = locationPatch.precision;
    }
    if ("accuracyMeters" in locationPatch) {
      values.locationAccuracyMeters = locationPatch.accuracyMeters;
    }
    if ("capturedAt" in locationPatch) {
      values.locationCapturedAt = locationPatch.capturedAt;
    }
  }
  if (patch.location !== undefined) {
    const place = patch.location;
    // The domain type allows a location with no coordinates — a row can carry
    // a precision and nothing else. Without a pair there is nothing to store
    // in a geography column, so that clears it rather than writing a partial.
    const pair =
      place?.coordinates && place.coordinates.length === 2
        ? place.coordinates
        : null;
    values.geog = pair
      ? sql`ST_SetSRID(ST_MakePoint(${pair[0]}, ${pair[1]}), 4326)::geography`
      : null;
    // Cleared together. A precision left behind without a pin would still
    // read as "building" and put the row back in the routable set.
    values.locationSource = place?.source ?? null;
    values.locationPrecision = place?.precision ?? null;
    values.locationAccuracyMeters = place?.accuracyMeters ?? null;
    values.locationCapturedAt = place?.capturedAt ?? null;
  }
  if (Object.keys(values).length === 0) return findUserById(id, tx);

  await exec(tx).update(users).set(values).where(eq(users.id, id));
  return findUserById(id, tx);
}

export async function setUserPassword(
  id: string,
  passwordHash: string,
  tx?: Executor,
): Promise<boolean> {
  if (!OBJECT_ID.test(id)) return false;
  const rows = await exec(tx)
    .update(users)
    .set({ password: passwordHash })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  return rows.length === 1;
}

export async function setUserOtp(
  id: string,
  which: "passwordReset" | "emailVerification",
  block: OtpBlock | null,
  tx?: Executor,
): Promise<boolean> {
  if (!OBJECT_ID.test(id)) return false;
  const column = which === "passwordReset" ? "passwordReset" : "emailVerification";
  const rows = await exec(tx)
    .update(users)
    .set({ [column]: block })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  return rows.length === 1;
}

export async function deleteUser(id: string, tx?: Executor): Promise<boolean> {
  if (!OBJECT_ID.test(id)) return false;
  const rows = await exec(tx)
    .delete(users)
    .where(eq(users.id, id))
    .returning({ id: users.id });
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Guarded updates
//
// Each of these is one statement carrying its own guard. A second concurrent
// call matches no row and does nothing, which is the entire reason they are
// not a read followed by a write.
// ---------------------------------------------------------------------------

/**
 * Opens the bonus window, once.
 *
 * Returns the timestamp if this call was the one that opened it, null if it
 * was already open. `IS NULL` is Mongo's `$exists: false` — and the column has
 * no default precisely so that "unset" can mean "clock not started" rather
 * than "started at the epoch".
 */
export async function startBonusWindow(
  userId: string,
  startedAt: Date,
  tx?: Executor,
): Promise<Date | null> {
  if (!OBJECT_ID.test(userId)) return null;
  const rows = await exec(tx)
    .update(users)
    .set({ profileBonusWindowStartedAt: startedAt })
    .where(
      and(eq(users.id, userId), isNull(users.profileBonusWindowStartedAt)),
    )
    .returning({ id: users.id });
  return rows.length === 1 ? startedAt : null;
}

/**
 * Pays the profile bonus, once.
 *
 * `profile_bonus_granted_at IS NULL` is the whole idempotency story: a second
 * call, concurrent or minutes later, matches no row and increments nothing.
 * Any check the caller makes beforehand is an optimisation; this is the
 * guarantee.
 */
export async function payProfileBonus(
  userId: string,
  points: number,
  grantedAt: Date,
  tx?: Executor,
): Promise<boolean> {
  if (!OBJECT_ID.test(userId)) return false;
  const rows = await exec(tx)
    .update(users)
    .set({
      profileBonusGrantedAt: grantedAt,
      profileBonusPoints: points,
      points: sql`${users.points} + ${points}`,
    })
    .where(and(eq(users.id, userId), isNull(users.profileBonusGrantedAt)))
    .returning({ id: users.id });
  return rows.length === 1;
}

/** Credits the referee, once. False means it was already granted. */
export async function claimReferralReward(
  userId: string,
  points: number,
  tx?: Executor,
): Promise<boolean> {
  if (!OBJECT_ID.test(userId)) return false;
  const rows = await exec(tx)
    .update(users)
    .set({
      referralRewardGranted: true,
      points: sql`${users.points} + ${points}`,
    })
    .where(
      and(
        eq(users.id, userId),
        or(
          ne(users.referralRewardGranted, true),
          isNull(users.referralRewardGranted),
        ),
      ),
    )
    .returning({ id: users.id });
  return rows.length === 1;
}

/** Credits the referrer. Unguarded by design — it pays per referral. */
export async function addPoints(
  userId: string,
  points: number,
  tx?: Executor,
): Promise<boolean> {
  if (!OBJECT_ID.test(userId)) return false;
  const rows = await exec(tx)
    .update(users)
    .set({ points: sql`${users.points} + ${points}` })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return rows.length === 1;
}

/**
 * Counts one wrong guess, against the exact code that was read.
 *
 * Guarded on the hash so parallel wrong guesses cannot race each other into
 * under-counting, and a concurrent resend cannot have its new code's counter
 * bumped by a guess against the old one.
 */
export async function recordOtpAttempt(
  userId: string,
  which: "passwordReset" | "emailVerification",
  otpHash: string,
  tx?: Executor,
): Promise<boolean> {
  if (!OBJECT_ID.test(userId)) return false;
  const column = which === "passwordReset" ? "password_reset" : "email_verification";
  const result = await exec(tx).execute(sql`
    UPDATE consumer.users
       SET ${sql.raw(column)} = jsonb_set(
             ${sql.raw(column)},
             '{attempts}',
             to_jsonb(COALESCE((${sql.raw(column)}->>'attempts')::int, 0) + 1))
     WHERE id = ${userId}
       AND ${sql.raw(column)}->>'otpHash' = ${otpHash}
    RETURNING id
  `);
  return ((result as unknown as { rows: unknown[] }).rows ?? []).length === 1;
}

/**
 * Burns the OTP, but only if it is still the one that was verified.
 *
 * Guards against a concurrent request having already consumed or rotated it —
 * without which a code could be spent twice.
 */
export async function consumeOtp(
  userId: string,
  which: "passwordReset" | "emailVerification",
  otpHash: string,
  tx?: Executor,
): Promise<boolean> {
  if (!OBJECT_ID.test(userId)) return false;
  const column = which === "passwordReset" ? "password_reset" : "email_verification";
  const result = await exec(tx).execute(sql`
    UPDATE consumer.users
       SET ${sql.raw(column)} = NULL
     WHERE id = ${userId}
       AND ${sql.raw(column)}->>'otpHash' = ${otpHash}
    RETURNING id
  `);
  return ((result as unknown as { rows: unknown[] }).rows ?? []).length === 1;
}

/** Marks the address verified and burns the code in one statement. */
export async function markEmailVerified(
  userId: string,
  otpHash: string,
  tx?: Executor,
): Promise<boolean> {
  if (!OBJECT_ID.test(userId)) return false;
  const result = await exec(tx).execute(sql`
    UPDATE consumer.users
       SET email_verification = NULL, email_verified = true
     WHERE id = ${userId}
       AND email_verification->>'otpHash' = ${otpHash}
    RETURNING id
  `);
  return ((result as unknown as { rows: unknown[] }).rows ?? []).length === 1;
}
