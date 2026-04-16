import mongoose, { Model, Schema } from "mongoose";
import connectToDatabase from "@/lib/mongodb";
import {
  BrandDocument,
  BrandThemeDocument,
  CampaignDocument,
  CollectionDocument,
  DiscountDocument,
  LocationDocument,
  LogisticsDocument,
  CaptainDocument,
  UserDocument,
} from "@/lib/types";

// Kick off the shared connection once per process. Mongoose will buffer
// operations until the underlying driver is connected.
void connectToDatabase();

export interface ILog extends Document {
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

const BrandSchema = new Schema<BrandDocument>(
  {
    companyName: stringRequired,
    brandName: stringRequired,
    email: { ...stringRequired, unique: true },
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
  },
  { timestamps: false },
);

const CampaignSchema = new Schema<CampaignDocument>(
  {
    name: stringRequired,
    startDate: stringRequired,
    endDate: stringRequired,
    discountCodes: {
      type: [String],
      required: true,
      validate: {
        validator: (codes: string[]) =>
          Array.isArray(codes) && codes.length > 0,
        message: "Discount codes must be a non empty array.",
      },
    },
    isSingleCode: { type: Boolean, required: true },
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
    users: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    brand: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
    },
    brandRegistration: stringRequired,
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

const DiscountSchema = new Schema<DiscountDocument>(
  {
    campaignName: String,
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "Campaign",
    },
    brand: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
    },
    startDate: stringRequired,
    endDate: stringRequired,
    locations: [
      {
        province: stringRequired,
        city: stringRequired,
        town: stringRequired,
        _id: false,
      },
    ],
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    code: { type: String, required: true },
    redeemEndTime: String,
    isDownloaded: { type: Boolean, default: false },
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
    phone: stringDefaultEmpty,
    mintId: { ...stringRequired, unique: true },
    role: { type: String, default: "MEMBER" },
    latitude: stringDefaultEmpty,
    longitude: stringDefaultEmpty,
    deviceToken: stringDefaultEmpty,
    points: { type: Number, default: 0 },
    totalCollections: stringDefaultEmpty,
    totalWasteCollected: stringDefaultEmpty,
    referrals: { type: [String], default: [] },
    pickupHistory: { type: [pickupHistorySchema], default: [] },
    created: { type: Date, default: Date.now },
    firstTimeLogin: { type: Boolean, default: true },
    otpVerification: String,
    emailVerified: { type: Boolean, default: false },
    verificationToken: String,
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
  }
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
export const DiscountModel = getModel<DiscountDocument>(
  "Discount",
  DiscountSchema,
  "discounts",
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

export const Log = mongoose.model<ILog>("Log", LogSchema);

export const UserModel = getModel<UserDocument>("User", UserSchema, "users");

export type {
  BrandDocument,
  CampaignDocument,
  CaptainDocument,
  CollectionDocument,
  DiscountDocument,
  LocationDocument,
  LogisticsDocument,
  BrandThemeDocument,
  UserDocument,
};
