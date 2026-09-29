import mongoose, { Model, Schema } from "mongoose";
import {
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


// Provisional brand-level impact snapshot pending the brand↔collection data
// pipeline. Once collections are brand-scoped, these figures can be derived.
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


