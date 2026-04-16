import { Document, Types } from "mongoose";

export type Role =
  | "ADMIN"
  | "MEMBER"
  | "LOGISTIC"
  | "BUSINESS_DEVELOPMENT"
  | "BD_ADMIN"
  | "CAPTAIN"
  | "BRAND";

export interface Brand {
  companyName: string;
  brandName: string;
  email: string;
  logo?: string;
  themeImage?: string;
  category: string;
  description?: string;
  address?: string;
  webLink: string;
  appLink?: string;
  contactName: string;
  phone: string;
  registrationNumber: string;
  domain?: string;
  themeColor?: string;
  status?: "PENDING" | "APPROVED" | "REJECTED";
  role: Role;
  emailVerified: boolean;
  verificationToken?: string;
}

export interface BrandDocument extends Brand, Document {}

export interface CampaignAddress {
  province: string;
  city: string;
  town: string;
}

export type CampaignStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface Campaign {
  name: string;
  startDate: string;
  endDate: string;
  discountCodes: string[];
  isSingleCode: boolean;
  discountPercentage?: string;
  addresses: CampaignAddress[];
  status: CampaignStatus;
  users: Types.ObjectId[];
  brand: Types.ObjectId;
  brandRegistration: string;
}

export interface CampaignDocument extends Campaign, Document {}

export interface Captain {
  name: string;
  phone: string;
  email: string;
  password: string;
  avatar: string;
  nationalId?: string;
  nationalIdImage?: string;
  role: Role;
  deviceToken: string;
  created: Date;
  emailVerified: boolean;
  verificationToken?: string;
}

export interface CaptainDocument extends Captain, Document {}

export interface CaptainDateAssignment {
  date: string;
  captain: Types.ObjectId;
}

export type CollectionStatus = "PENDING" | "COMPLETED";

export interface Collection {
  name: string;
  area: string;
  city: string;
  radius: string;
  startAreaLat: string;
  startAreaLang: string;
  startDate: string;
  status: CollectionStatus;
  users: Types.ObjectId[];
  captainsWithDates: CaptainDateAssignment[];
}

export interface CollectionDocument extends Collection, Document {}

export interface DiscountLocation {
  province: string;
  city: string;
  town: string;
}

export interface Discount {
  campaignName?: string;
  campaignId?: Types.ObjectId;
  brand?: Types.ObjectId;
  startDate: string;
  endDate: string;
  locations: DiscountLocation[];
  user?: Types.ObjectId;
  code: string;
  redeemEndTime?: string;
  isDownloaded: boolean;
}

export interface DiscountDocument extends Discount, Document {}

export interface LocationCity {
  name: string;
  towns: string[];
}

export interface Location {
  province: string;
  cities: LocationCity[];
}

export interface LocationDocument extends Location, Document {}

export interface Logistics {
  name: string;
  phone: string;
  email: string;
  password: string;
  avatar: string;
  role: Role;
  deviceToken: string;
  created: Date;
  emailVerified: boolean;
  verificationToken?: string;
}

export interface LogisticsDocument extends Logistics, Document {}

export interface BrandTheme {
  name: string;
  logo: string;
  backgroundColor: string;
  accentColor: string;
  status: string;
}

export interface BrandThemeDocument extends BrandTheme, Document {}

export interface QrCodeWeight {
  qrCode: string;
  weight: number;
}

export interface PickupHistoryEntry {
  collectionId: Types.ObjectId;
  collectionName: string;
  date: Date;
  captain: Types.ObjectId;
  qrCodesWithWeights: QrCodeWeight[];
  status: string;
  comment: string;
}

export interface User {
  userName: string;
  email: string;
  password: string;
  avatar: string;
  address: string;
  province: string;
  city: string;
  town: string;
  phone: string;
  mintId: string;
  role: Role;
  latitude: string;
  longitude: string;
  deviceToken: string;
  points: number;
  totalCollections: string;
  totalWasteCollected: string;
  referrals: string[];
  pickupHistory: PickupHistoryEntry[];
  created: Date;
  firstTimeLogin: boolean;
  otpVerification?: string;
  emailVerified: boolean;
  verificationToken?: string;
}

export interface UserDocument extends User, Document {}
