import mongoose, { Model, Schema } from "mongoose";
import {
  UserDocument,
} from "@/lib/types";

// INVARIANT: this module never opens the DB connection at import time.
// The driver runs with bufferCommands:false (see lib/mongodb.ts), so every
// caller MUST `await connectToDatabase()` before issuing a query — routes do
// this at the top of each handler, and shared helpers (requireBrandScope,
// requireModuleAccess) await it before their first query.

export interface ILog extends mongoose.Document {
  // Event classification
  event: string;
  level: "info" | "warn" | "error";

  // User context
  userId?: string;
  userEmail?: string;

  // Navigation context
  route?: string;
  previousRoute?: string;

  // Device / app context
  deviceId: string;
  deviceModel: string;
  platform: "ios" | "android" | "web" | string;
  appVersion: string;
  buildNumber: string;

  // Timing
  timestamp: Date;

  // Arbitrary extra data
  extra?: Record<string, unknown>;
}

const stringRequired = { type: String, required: true } as const;
const stringDefaultEmpty = { type: String, default: "" } as const;

// Provisional brand-level impact snapshot pending the brand↔collection data
// pipeline. Once collections are brand-scoped, these figures can be derived.
const qrCodeWithWeightSchema = new Schema(
  {
    qrCode: stringDefaultEmpty,
    weight: { type: Number, default: 0 },
  },
  { _id: false },
);

// P0.4a — the user's address frozen at pickup creation. Optional so that
// entries written before this shipped stay valid; new entries must carry it
// (the writer builds it with buildPickupAddressSnapshot in lib/pickupSnapshot.ts).
// Field shapes deliberately mirror the User schema's legacy strings plus the
// P0.3 `structuredAddress`/`location` blocks, minus indexes.
const pickupAddressSnapshotSchema = new Schema(
  {
    address: stringDefaultEmpty,
    province: stringDefaultEmpty,
    city: stringDefaultEmpty,
    town: stringDefaultEmpty,
    townOther: stringDefaultEmpty,
    subArea: stringDefaultEmpty,
    subAreaOther: stringDefaultEmpty,
    structuredAddress: {
      cityId: String,
      areaId: String,
      blockId: String,
      areaOther: String,
      blockOther: String,
      houseNo: String,
      streetOrBlock: String,
    },
    location: {
      type: { type: String, enum: ["Point"] },
      // [lng, lat] — GeoJSON order.
      coordinates: { type: [Number], default: undefined },
      source: {
        type: String,
        enum: [
          "map_pin",
          "area_centroid",
          "city_centroid",
          "legacy_string",
          "collector_verified",
        ],
      },
      precision: {
        type: String,
        enum: ["building", "block", "area", "city", "unknown"],
      },
      accuracyMeters: Number,
      capturedAt: Date,
    },
    // "creation" = written when the pickup was created (the honest snapshot).
    // "migrated" = backfilled by P0.4b from the address as it stood at
    // migration time — NOT necessarily the address at pickup time.
    snapshotSource: {
      type: String,
      enum: ["creation", "migrated"],
      required: true,
    },
    snapshotAt: { type: Date, required: true },
  },
  { _id: false },
);

const pickupHistorySchema = new Schema(
  {
    // Plain ObjectIds, not refs. The Collection and Captain models were
    // removed as dead code — nothing read them, and operations moved to the
    // admin API's Postgres. A `ref` to an unregistered model is a
    // MissingSchemaError waiting for the first populate() someone writes.
    collectionId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    collectionName: stringRequired,
    date: { type: Date, default: Date.now },
    captain: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    qrCodesWithWeights: {
      type: [qrCodeWithWeightSchema],
      default: [],
    },
    status: stringRequired,
    comment: stringDefaultEmpty,
    // Optional: absent on entries created before P0.4a.
    addressSnapshot: { type: pickupAddressSnapshotSchema, required: false },
  },
  { _id: false },
);

const UserSchema = new Schema<UserDocument>(
  {
    userName: stringRequired,
    email: { ...stringRequired, unique: true, lowercase: true },
    password: stringRequired,
    avatar: stringDefaultEmpty,
    address: stringDefaultEmpty,
    province: stringDefaultEmpty,
    city: stringDefaultEmpty,
    town: stringDefaultEmpty,
    townOther: stringDefaultEmpty,
    subArea: stringDefaultEmpty,
    subAreaOther: stringDefaultEmpty,
    phone: stringDefaultEmpty,
    mintId: { ...stringRequired, unique: true },
    role: { type: String, default: "MEMBER" },
    latitude: stringDefaultEmpty,
    longitude: stringDefaultEmpty,
    deviceToken: stringDefaultEmpty,
    points: { type: Number, default: 0 },
    totalCollections: stringDefaultEmpty,
    totalWasteCollected: stringDefaultEmpty,
    // Unbounded: every address this user has ever referred, never pruned. At
    // the current rate limit (3 requests/hour, 10 addresses each) the 16MB
    // document cap is months away, and issue #144 may relocate this data
    // entirely — so this is a caveat, not a task. See the multikey index on
    // this field below.
    referrals: { type: [String], default: [] },
    referralRewardGranted: { type: Boolean, default: false },

    // ---- Structured location (P0.3) ------------------------------------
    // Additive. `latitude`, `longitude`, `address`, `province`, `city`,
    // `town`, `townOther`, `subArea` and `subAreaOther` above are UNCHANGED
    // and dual-written until every reader has migrated to these fields.
    //
    // NOTE the type mismatch with the legacy pair: `latitude`/`longitude` are
    // Strings defaulting to "", while GeoJSON coordinates are [Number]. Any
    // dual-write must parseFloat and SKIP the GeoJSON write when the legacy
    // string is "" or unparseable — writing NaN into a 2dsphere-indexed field
    // makes the document unindexable.
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      // [lng, lat] — GeoJSON order, the reverse of how humans say it.
      coordinates: { type: [Number] },
      source: {
        type: String,
        enum: [
          "map_pin",
          "area_centroid",
          "city_centroid",
          "legacy_string",
          "collector_verified",
        ],
      },
      // Anything other than "building" must be excluded from routing: every
      // user on a centroid path shares one identical coordinate, which is
      // usable for clustering but not for getting a collector to a door.
      precision: {
        type: String,
        enum: ["building", "block", "area", "city", "unknown"],
      },
      accuracyMeters: Number,
      capturedAt: Date,
    },

    // Canonical registry values. The registry has no synthetic ids — its keys
    // ARE the display names, which is exactly why those strings can never be
    // edited (see utils/pakistan_areas.ts in the app repo). `cityId` holds
    // "Karachi", not a slug.
    structuredAddress: {
      cityId: String,
      areaId: String,
      blockId: String,
      // Free text, used when the registry has no matching entry. Mutually
      // exclusive with the canonical field beside it, mirroring the existing
      // town/townOther and subArea/subAreaOther pairs.
      areaOther: String,
      blockOther: String,
      houseNo: String,
      streetOrBlock: String,
    },

    locationVerification: {
      status: {
        type: String,
        enum: [
          "unverified",
          "auto_verified",
          "user_corrected",
          "mismatch",
          "unresolved",
        ],
      },
      method: String,
      // NEVER collapse geocodedAreaRaw with selectedAreaId. Every row where
      // they differ is a labelled geocoder failure at a known coordinate — the
      // training data for the gazetteer. Overwriting one throws that away.
      geocodedAreaRaw: String,
      geocodedAreaId: String,
      selectedAreaId: String,
      distanceMeters: Number,
      checkedAt: Date,
      resolvedBy: String,
    },

    // Server-side completion definition is versioned so a future re-prompt is
    // a version bump plus a registry addition, not a client release.
    locationVersion: { type: Number, default: 0 },
    locationCompletedAt: Date,

    // ---- Profile-completion bonus --------------------------------------
    // All three are SERVER-STAMPED. None appears in update-profile's two
    // allowlists, and none may be added there: a user who can write
    // `profileBonusGrantedAt` can decide whether they have been paid, and a
    // user who can write `profileBonusWindowStartedAt` can restart their own
    // 24-hour window indefinitely.
    //
    // Deliberately NOT defaulted. `profileBonusGrantedAt` is the idempotency
    // key for the payout — the claim in lib/profileBonus.ts filters on
    // `{ $exists: false }`, which is what makes a concurrent second call match
    // nothing. A default would make the field exist on every document from
    // creation and the filter would never match anyone. Same reasoning for the
    // window stamp, where "unset" is what distinguishes a user whose clock has
    // not started from one whose clock started at the epoch.
    /** When this user's bonus window opened — stamped on their first app open. */
    profileBonusWindowStartedAt: Date,
    /** When the bonus was paid. Presence is the idempotency key; never unset. */
    profileBonusGrantedAt: Date,
    // How much was actually paid. There is no points ledger in this system, so
    // absent this field there would be no record of the amount at all — and the
    // amount is config-driven (PROFILE_BONUS_POINTS), so it can differ between
    // two users paid on different days of the same campaign.
    profileBonusPoints: Number,

    pickupHistory: { type: [pickupHistorySchema], default: [] },
    created: { type: Date, default: Date.now },
    firstTimeLogin: { type: Boolean, default: true },
    // select:false so the OTP hash never leaks through toObject()/find()
    passwordReset: {
      type: new Schema(
        {
          otpHash: String,
          expiresAt: Date,
          attempts: { type: Number, default: 0 },
          lastSentAt: Date,
        },
        { _id: false },
      ),
      select: false,
    },
    // select:false so the OTP hash never leaks through toObject()/find()
    emailVerification: {
      type: new Schema(
        {
          otpHash: String,
          expiresAt: Date,
          attempts: { type: Number, default: 0 },
          lastSentAt: Date,
        },
        { _id: false },
      ),
      select: false,
    },
    emailVerified: { type: Boolean, default: false },
    appleId: { type: String, sparse: true, unique: true },
  },
  { timestamps: false },
);

const LogSchema = new Schema<ILog>(
  {
    event: { type: String, required: true, index: true },
    level: {
      type: String,
      enum: ["info", "warn", "error"],
      default: "info",
      index: true,
    },

    // User context — optional so pre-auth events are still captured
    userId: { type: String, index: true },
    userEmail: { type: String },

    // Navigation context
    route: { type: String, index: true },
    previousRoute: { type: String },

    // Device context
    deviceId: { type: String, required: true, index: true },
    deviceModel: { type: String, default: "unknown" },
    platform: { type: String, required: true },
    appVersion: { type: String, required: true },
    buildNumber: { type: String, required: true },

    // ISO timestamp sent from the client
    timestamp: { type: Date, required: true, index: true },

    // Flexible blob for event-specific data
    extra: { type: Schema.Types.Mixed },
  },
  {
    // Disable Mongoose auto-timestamps — we use the client timestamp field
    timestamps: false,
    // Store as a lean collection — logs are write-heavy, rarely updated
    versionKey: false,
  },
);

const getModel = <T extends mongoose.Document>(
  name: string,
  schema: Schema<T>,
  collection?: string,
): Model<T> =>
  (mongoose.models[name] as Model<T>) ||
  mongoose.model<T>(name, schema, collection);



// Compound index for the most common dashboard queries
LogSchema.index({ userId: 1, timestamp: -1 });
LogSchema.index({ event: 1, timestamp: -1 });
LogSchema.index({ deviceId: 1, timestamp: -1 });
// TTL index — automatically purge logs older than 90 days
LogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const Log = getModel<ILog>("Log", LogSchema);

// Multikey index over the referral address array. POST /api/users/referrals
// runs a `referrals: { $in: [...] }` lookup on every request to establish
// whether an address has already been invited by anyone; unindexed that is a
// collection scan across every user, and it only gets more expensive.
UserSchema.index({ referrals: 1 });

export const UserModel = getModel<UserDocument>("User", UserSchema, "users");


export type {
  UserDocument,
};
