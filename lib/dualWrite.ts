import type { Schema } from "mongoose";
import { dualWritePool } from "@/lib/postgres";
import {
  MIRRORED,
  NESTED_CHILDREN,
  SECRET_COLUMNS,
  camelCase,
} from "@/lib/mirroredTables";

/**
 * Mirrors Mongo writes into Postgres for the 30-day migration window.
 *
 * THE RULE: Mongo is authoritative and a Postgres failure must never reach the
 * user. Every path here swallows its errors. A shadow store nobody depends on
 * yet must not be able to double the failure surface of a store everybody
 * does. `scripts/reconcile-mongo-postgres.mjs` is what turns those swallowed
 * failures back into evidence — without it this file is unfalsifiable.
 *
 * Writes are AWAITED rather than fired and forgotten. On a serverless host a
 * detached promise may never run: the function freezes once the response is
 * sent, and the mirror silently stops happening in exactly the environment it
 * matters in. Awaiting costs latency, so every call is bounded by
 * MIRROR_TIMEOUT_MS and gives up rather than holding a request open.
 *
 * Updates are handled by re-reading the document and mirroring it whole, not
 * by translating `$set` paths into columns. The plan called for the latter;
 * this is a deliberate departure. Dotted paths (`location.coordinates.0`),
 * positional operators and `$inc`/`$push` would each need their own
 * translation, every one a chance to write a subtly wrong column, and the bug
 * would look exactly like a lost write. Re-reading costs one query and is
 * correct by construction.
 */

const MIRROR_TIMEOUT_MS = 2000;

type Doc = Record<string, unknown> & { _id: unknown };

/** Column metadata per table, read once from the target and cached. */
const columnCache = new Map<string, Promise<ColumnInfo[]>>();
interface ColumnInfo {
  name: string;
  isDate: boolean;
}

function log(message: string, err?: unknown) {
  const detail = err instanceof Error ? err.message : err ? String(err) : "";
  console.error(`[dual-write] ${message}${detail ? `: ${detail}` : ""}`);
}

async function columnsOf(table: string): Promise<ColumnInfo[]> {
  let cached = columnCache.get(table);
  if (!cached) {
    cached = (async () => {
      const pool = dualWritePool();
      if (!pool) return [];
      const { rows } = await pool.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1`,
        [table],
      );
      return rows
        .filter((r) => !SECRET_COLUMNS.has(r.column_name))
        .map((r) => ({
          name: r.column_name,
          isDate: r.data_type.startsWith("timestamp") || r.data_type === "date",
        }));
    })();
    columnCache.set(table, cached);
  }
  return cached;
}

/** Postgres will not take an ObjectId, a Mongoose subdocument or a NaN. */
function toColumnValue(value: unknown, col: ColumnInfo): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && typeof (value as { toHexString?: unknown }).toHexString === "function") {
    return (value as { toHexString: () => string }).toHexString();
  }
  if (col.isDate && typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t);
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

async function upsert(
  table: string,
  keyColumn: string,
  row: Record<string, unknown>,
): Promise<void> {
  const pool = dualWritePool();
  if (!pool) return;
  const cols = Object.keys(row);
  if (cols.length === 0) return;
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const updates = cols
    .filter((c) => c !== keyColumn)
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");
  await pool.query(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")})
     VALUES (${placeholders})
     ON CONFLICT ("${keyColumn}") DO UPDATE SET ${updates || `"${keyColumn}" = EXCLUDED."${keyColumn}"`}`,
    cols.map((c) => row[c]),
  );
}

async function mirrorOne(collection: string, doc: Doc): Promise<void> {
  const table = MIRRORED[collection as keyof typeof MIRRORED];
  if (!table) return;
  const id = String(doc._id);

  const cols = await columnsOf(table);
  if (cols.length === 0) return;
  const row: Record<string, unknown> = { id };
  for (const col of cols) {
    if (col.name === "id") continue;
    row[col.name] = toColumnValue(doc[camelCase(col.name)], col);
  }
  await upsert(table, "id", row);

  for (const [childTable, spec] of Object.entries(NESTED_CHILDREN)) {
    if (spec.collection !== collection) continue;
    const pool = dualWritePool();
    if (!pool) return;
    if (!spec.present(doc)) {
      await pool.query(`DELETE FROM "${childTable}" WHERE "${spec.key}" = $1`, [id]);
      continue;
    }
    const childCols = await columnsOf(childTable);
    const childRow: Record<string, unknown> = { [spec.key]: id };
    for (const col of childCols) {
      const get = spec.fields[col.name as keyof typeof spec.fields];
      if (!get) continue;
      childRow[col.name] = toColumnValue(get(doc), col);
    }
    await upsert(childTable, spec.key, childRow);
  }
}

async function removeOne(collection: string, id: string): Promise<void> {
  const table = MIRRORED[collection as keyof typeof MIRRORED];
  const pool = dualWritePool();
  if (!table || !pool) return;
  // Children go with the parent by ON DELETE CASCADE where declared; the
  // explicit delete covers the tables where it is not.
  for (const [childTable, spec] of Object.entries(NESTED_CHILDREN)) {
    if (spec.collection !== collection) continue;
    await pool.query(`DELETE FROM "${childTable}" WHERE "${spec.key}" = $1`, [id]);
  }
  await pool.query(`DELETE FROM "${table}" WHERE id = $1`, [id]);
}

/** Bounded, and silent about everything except the log line. */
async function guarded(what: string, run: () => Promise<void>): Promise<void> {
  if (!dualWritePool()) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${MIRROR_TIMEOUT_MS}ms`)), MIRROR_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    log(what, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function mirrorDocument(collection: string, doc: unknown): Promise<void> {
  if (!doc || typeof doc !== "object") return;
  await guarded(`upsert ${collection}`, () => mirrorOne(collection, doc as Doc));
}

export async function mirrorDeletion(collection: string, id: string): Promise<void> {
  await guarded(`delete ${collection}/${id}`, () => removeOne(collection, id));
}

/** Test seam: forget cached column lists after the target schema changes. */
export function resetDualWriteCaches(): void {
  columnCache.clear();
}

// Query middleware runs for these; document middleware does not.
const UPDATE_OPS = [
  "findOneAndUpdate",
  "updateOne",
  "updateMany",
  "replaceOne",
] as const;
const DELETE_OPS = ["findOneAndDelete", "deleteOne", "deleteMany"] as const;

interface WithIds {
  _dualWriteIds?: string[];
}

/**
 * Attaches the mirror to one schema. Called from getModel in lib/models.ts, so
 * every model is covered by construction rather than by remembering — 44 write
 * sites across 31 route files, and only 8 of them are `.save()`, so document
 * middleware alone would miss four fifths of them.
 */
export function attachDualWrite<T>(schema: Schema<T>, collection?: string): void {
  if (!collection || !(collection in MIRRORED)) return;

  // Documents: .save(), and Model.create() which routes through it.
  schema.post("save", async function (doc: unknown) {
    await mirrorDocument(collection, doc);
  });

  schema.post("insertMany", async function (docs: unknown) {
    if (!Array.isArray(docs)) return;
    for (const doc of docs) await mirrorDocument(collection, doc);
  });

  // Queries. The ids are captured BEFORE the write, because a filter can stop
  // matching the document it just changed (and after a delete there is nothing
  // left to look up at all).
  for (const op of [...UPDATE_OPS, ...DELETE_OPS]) {
    schema.pre(op, async function (this: WithIds & { model: { find: Function }; getFilter: () => object }) {
      if (!dualWritePool()) return;
      try {
        const docs = await this.model.find(this.getFilter(), { _id: 1 }).lean();
        this._dualWriteIds = (docs as { _id: unknown }[]).map((d) => String(d._id));
      } catch (err) {
        log(`could not resolve ids for ${collection}.${op}`, err);
        this._dualWriteIds = [];
      }
    });
  }

  for (const op of UPDATE_OPS) {
    schema.post(op, async function (this: WithIds & { model: { find: Function } }) {
      const ids = this._dualWriteIds;
      if (!ids?.length || !dualWritePool()) return;
      try {
        const fresh = await this.model.find({ _id: { $in: ids } }).lean();
        for (const doc of fresh as Doc[]) await mirrorDocument(collection, doc);
      } catch (err) {
        log(`could not re-read ${collection} after ${op}`, err);
      }
    });
  }

  for (const op of DELETE_OPS) {
    schema.post(op, async function (this: WithIds) {
      for (const id of this._dualWriteIds ?? []) await mirrorDeletion(collection, id);
    });
  }
}
