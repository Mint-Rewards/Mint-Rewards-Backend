import mongoose from "mongoose";

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
    const MONGODB_URI = process.env.MONGODB_URI;

    if (!MONGODB_URI) {
      throw new Error(
        "Please define the MONGODB_URI environment variable inside .env.local",
      );
    }

    const opts = {
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000,
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
