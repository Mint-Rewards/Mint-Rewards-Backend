import mongoose from "mongoose";
import { serverEnv } from "@/lib/env";

type MongooseCache = {
  conn: typeof import("mongoose") | null;
  promise: Promise<typeof import("mongoose")> | null;
};

declare global {
  var mongoose: MongooseCache | undefined;
}

/**
 * Global is used here to maintain a cached connection across hot reloads
 * in development. This prevents connections growing exponentially
 * during API Route usage.
 *
 * Under Jest, writing this cache onto `global` trips jest-util's
 * cross-test-file global leak detection: a late write to `cached.promise`
 * (e.g. after a rejected connection) lands on a "soft deleted" global and
 * crashes the worker with "Maximum call stack size exceeded". Tests don't
 * need the hot-reload behavior, so use a plain module-level cache instead.
 *
 * IMPORTANT when changing env/URI configuration: this cache survives HMR, and
 * `serverEnv` is parsed once at module load. Editing .env (or any variable that
 * feeds resolveMongoUriKey) and letting Next hot-reload will keep serving the
 * connection opened under the OLD value — a full server restart is required.
 * This produced a false-negative during recent debugging, where a corrected URI
 * looked like it had no effect.
 */
const cached: MongooseCache = process.env.JEST_WORKER_ID
  ? { conn: null, promise: null }
  : (global.mongoose ??= { conn: null, promise: null });

// Primary database connection
async function connectToDatabase() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    // Reading process.env.MONGODB_URI directly here bypassed lib/env.ts, so
    // APP_ENV=development preferring MONGODB_URI_TEST had no effect on the
    // connection the app actually opened — the only thing that ever redirected
    // it was jest.setup.js overwriting process.env before import.
    const MONGODB_URI = serverEnv.mongodbUri;

    // Serverless invocations should give up fast rather than hold a function
    // open, so 5s is right in production. Under jest it is not: a CI runner
    // reaching Atlas cold routinely takes longer, and 5s also happens to be
    // jest's default hook/test timeout — the two clocks expire together, jest
    // wins the race, and the real MongoServerSelectionError is never printed.
    // Suites see "Exceeded timeout of 5000 ms for a hook" and nothing else.
    const opts = {
      bufferCommands: false,
      serverSelectionTimeoutMS: process.env.JEST_WORKER_ID ? 20000 : 5000,
    };

    cached.promise = mongoose.connect(MONGODB_URI, opts).then((mongoose) => {
      return mongoose;
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    throw e;
  }

  return cached.conn;
}

export default connectToDatabase;

// Utility function to handle database operations with error handling
export async function withDatabase<T>(operation: () => Promise<T>): Promise<T> {
  try {
    await connectToDatabase();
    return await operation();
  } catch (error) {
    console.error("Database operation failed:", error);
    throw error;
  }
}

// Utility to get both connections
export async function connectToBothDatabases() {
  const [primary] = await Promise.all([connectToDatabase()]);

  return { primary };
}
