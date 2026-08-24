import mongoose, { Model, Schema } from "mongoose";
import {
  BrandDocument,
  BrandThemeDocument,
  CampaignDocument,
  CollectionDocument,
  DealDocument,
  LocationDocument,
  LogisticsDocument,
  CaptainDocument,
  UserDocument,
  OrganizationDocument,
  BrandUserDocument,
} from "@/lib/types";
import { PERMISSION_LEVELS, ORG_ROLES } from "@/lib/modules";

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
const MaterialBreakdownSchema = new Schema(
  {
    material: stringRequired,
    weightKg: { type: Number, required: true },
  },
  { _id: false },
);

const EnvironmentalStatsSchema = new Schema(
  {
    totalWasteKg: { type: Number, required: true },
    co2AvoidedKg: { type: Number, required: true },
    materialBreakdown: { type: [MaterialBreakdownSchema], default: [] },
  },
  { _id: false },
);

// A dated bucket. Kept as a SEPARATE field from environmentalStats rather than
// changing that field's type: existing documents hold a single subdocument
// there, and retyping it to an array would break every legacy brand on read.
// The analytics route prefers buckets and falls back to the snapshot.
const EnvironmentalPeriodSchema = new Schema(
  {
    periodStart: stringRequired,
    periodEnd: stringRequired,
    totalWasteKg: { type: Number, required: true },
    co2AvoidedKg: { type: Number, required: true },
    materialBreakdown: { type: [MaterialBreakdownSchema], default: [] },
  },
  { _id: false },
);

const BrandSchema = new Schema<BrandDocument>(
  {
    // Optional: legacy brands predate organizations and must stay valid.
    orgId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    // Set on documents cloned from a legacy brand by
    // scripts/clone-legacy-brands.js, pairing this document with its source.
    // This pairing used to be encoded in `email` as legacy-<24hex>@example.com,
    // which made contact data load-bearing: correcting the email in BrandHub
    // Settings silently unjoined every campaign resolving through it. See
    // lib/legacyBrandEmail.ts.
    legacyBrandId: { type: Schema.Types.ObjectId, ref: "Brand", index: true },
    companyName: stringRequired,
    brandName: stringRequired,
    email: { ...stringRequired, unique: true, lowercase: true, trim: true },
    logo: String,
    themeImage: String,
    category: stringRequired,
    description: stringDefaultEmpty,
    address: stringDefaultEmpty,
    webLink: stringRequired,
    appLink: stringDefaultEmpty,
    contactName: stringRequired,
    phone: stringRequired,
    registrationNumber: { ...stringRequired, unique: true },
    domain: stringDefaultEmpty,
    themeColor: { type: String, default: "#3B82F6" },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
      required: true,
    },
    role: { type: String, default: "BRAND" },
    emailVerified: { type: Boolean, default: false },
    verificationToken: String,
    environmentalStats: { type: EnvironmentalStatsSchema, default: undefined },
    environmentalPeriods: {
      type: [EnvironmentalPeriodSchema],
      default: undefined,
    },
  },
  { timestamps: true },
);

const CampaignSchema = new Schema<CampaignDocument>(
  {
    name: stringRequired,
    startDate: String,
    endDate: String,
    discountCodes: { type: [String], default: [] },
    isSingleCode: { type: Boolean, default: false },
    discountPercentage: String,
    addresses: [
      {
        province: stringRequired,
        city: stringRequired,
        town: stringRequired,
        _id: false,
      },
    ],
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "EXPIRED"],
      default: "PENDING",
      required: true,
    },
    users: [{ type: Schema.Types.ObjectId, ref: "User" }],
    brand: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
    },
    brandRegistration: { type: String, default: "" },
    // Brand-portal fields (set at creation time)
    description: String,
    campaignType: String,
    targetAudience: String,
    budget: Number,
    backgroundColor: String,
    badge: String,
    subtitle: String,
    banner: String,
  },
  { timestamps: false },
);

const CaptainSchema = new Schema<CaptainDocument>(
  {
    name: stringRequired,
    phone: stringRequired,
    email: { ...stringRequired, unique: true, lowercase: true },
    password: stringRequired,
    avatar: stringDefaultEmpty,
    nationalId: String,
    nationalIdImage: String,
    role: { type: String, default: "CAPTAIN" },
    deviceToken: stringDefaultEmpty,
    created: { type: Date, default: Date.now },
    emailVerified: { type: Boolean, default: false },
    verificationToken: String,
  },
  { timestamps: false },
);

const CollectionSchema = new Schema<CollectionDocument>(
  {
    name: stringRequired,
    area: stringRequired,
    city: stringRequired,
    radius: stringRequired,
    startAreaLat: stringRequired,
    startAreaLang: stringRequired,
    startDate: stringRequired,
    status: {
      type: String,
      enum: ["PENDING", "COMPLETED"],
      default: "PENDING",
      required: true,
    },
    users: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    captainsWithDates: [
      {
        date: stringRequired,
        captain: {
          type: Schema.Types.ObjectId,
          ref: "Captain",
          required: true,
        },
        _id: false,
      },
    ],
  },
  { timestamps: false },
);

const LocationSchema = new Schema<LocationDocument>(
  {
    province: stringRequired,
    cities: [
      {
        name: { ...stringRequired, trim: true },
        towns: [{ type: String, trim: true }],
        _id: false,
      },
    ],
  },
  { timestamps: false },
);

const LogisticsSchema = new Schema<LogisticsDocument>(
  {
    name: stringRequired,
    phone: stringRequired,
    email: { ...stringRequired, unique: true, lowercase: true },
    password: stringRequired,
    avatar: stringDefaultEmpty,
    role: { type: String, default: "LOGISTIC" },
    deviceToken: stringDefaultEmpty,
    created: { type: Date, default: Date.now },
    emailVerified: { type: Boolean, default: false },
    verificationToken: String,
  },
  { timestamps: false },
);

const BrandThemeSchema = new Schema<BrandThemeDocument>(
  {
    name: stringRequired,
    logo: stringRequired,
    backgroundColor: stringRequired,
    accentColor: stringRequired,
    status: stringRequired,
  },
  { timestamps: false },
);

const qrCodeWithWeightSchema = new Schema(
  {
    qrCode: stringDefaultEmpty,
    weight: { type: Number, default: 0 },
  },
  { _id: false },
);

const pickupHistorySchema = new Schema(
  {
    collectionId: {
      type: Schema.Types.ObjectId,
      ref: "Collection",
      required: true,
    },
    collectionName: stringRequired,
    date: { type: Date, default: Date.now },
    captain: {
      type: Schema.Types.ObjectId,
      ref: "Captain",
      required: true,
    },
    qrCodesWithWeights: {
      type: [qrCodeWithWeightSchema],
      default: [],
    },
    status: stringRequired,
    comment: stringDefaultEmpty,
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

export const BrandModel = getModel<BrandDocument>(
  "Brand",
  BrandSchema,
  "brands",
);
export const CampaignModel = getModel<CampaignDocument>(
  "Campaign",
  CampaignSchema,
  "campaigns",
);

export const CaptainModel = getModel<CaptainDocument>(
  "Captain",
  CaptainSchema,
  "captains",
);
export const CollectionModel = getModel<CollectionDocument>(
  "Collection",
  CollectionSchema,
  "collections",
);
export const LocationModel = getModel<LocationDocument>(
  "Location",
  LocationSchema,
  "locations",
);
export const LogisticsModel = getModel<LogisticsDocument>(
  "Logistics",
  LogisticsSchema,
  "logistics",
);
export const BrandThemeModel = getModel<BrandThemeDocument>(
  "BrandTheme",
  BrandThemeSchema,
  "brandthemes",
);

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

const DealSchema = new Schema<DealDocument>(
  {
    brand: { type: Schema.Types.ObjectId, ref: "Brand", required: true },
    title: stringRequired,
    description: stringDefaultEmpty,
    discountPercentage: { type: Number, default: null },
    discountAmount: { type: Number, default: null },
    // Inventory of codes; promoCode mirrors codes[0] for legacy readers.
    codes: { type: [String], default: [] },
    promoCode: { type: String, default: null },
    startDate: { type: String, default: null },
    endDate: { type: String, default: null },
    maxUses: { type: Number, default: null },
    currentUses: { type: Number, default: 0 },
    minimumPurchase: { type: Number, default: null },
    status: {
      type: String,
      enum: ["pending", "active", "rejected", "inactive", "expired"],
      default: "pending",
    },
    users: [{ type: Schema.Types.ObjectId, ref: "User" }],
    claims: {
      type: [
        {
          user: { type: Schema.Types.ObjectId, ref: "User", required: true },
          code: stringRequired,
          claimedAt: { type: Date, default: Date.now },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

export const DealModel = getModel<DealDocument>("Deal", DealSchema, "deals");

const ModuleAccessSchema = new Schema(
  {
    module: stringRequired,
    permissions: [{ type: String, enum: PERMISSION_LEVELS }],
  },
  { _id: false },
);

const OrganizationSchema = new Schema<OrganizationDocument>(
  {
    name: stringRequired,
    plan: {
      type: String,
      enum: ["starter", "growth", "enterprise"],
      default: "starter",
    },
    moduleSubscriptions: {
      type: [
        {
          module: stringRequired,
          status: {
            type: String,
            enum: ["active", "trial", "expired", "cancelled"],
            required: true,
          },
          activatedAt: { type: Date, required: true },
          expiresAt: { type: Date, default: null },
          _id: false,
        },
      ],
      // Settings is not a module anymore (brand-profile editing gates on
      // org role, not a subscription) — new orgs start unsubscribed.
      default: () => [],
    },
  },
  { timestamps: true },
);

export const OrganizationModel = getModel<OrganizationDocument>(
  "Organization",
  OrganizationSchema,
  "organizations",
);

const BrandUserSchema = new Schema<BrandUserDocument>(
  {
    orgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    email: { ...stringRequired, unique: true, lowercase: true, trim: true },
    passwordHash: stringRequired,
    orgRole: { type: String, enum: ORG_ROLES, required: true },
    moduleAccess: { type: [ModuleAccessSchema], default: [] },
  },
  { timestamps: true },
);

export const BrandUserModel = getModel<BrandUserDocument>(
  "BrandUser",
  BrandUserSchema,
  "brandusers",
);

export type {
  BrandDocument,
  CampaignDocument,
  CaptainDocument,
  CollectionDocument,
  DealDocument,
  LocationDocument,
  LogisticsDocument,
  BrandThemeDocument,
  UserDocument,
  OrganizationDocument,
  BrandUserDocument,
};
