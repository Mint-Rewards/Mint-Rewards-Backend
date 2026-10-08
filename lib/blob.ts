/**
 * The credential for the Blob store, or undefined — which is the normal answer.
 *
 * Connected projects authenticate to the store over OIDC, so on Vercel there
 * is usually no token to pass and @vercel/blob arranges its own access. The
 * store injects a differently prefixed name into each project it is connected
 * to — `BLOB_READ_WRITE_TOKEN` for the admin API, `BLOB_PUBLIC_*` for the
 * production backend, and none at all for the dev backend.
 *
 * Returning undefined is therefore correct and not a failure. Passing a WRONG
 * token is the failure: a hand-added `BLOB_PUBLIC_READ_WRITE_TOKEN` predating
 * OIDC sat on the dev project, the SDK preferred it because it was there, and
 * the store answered
 *
 *   Vercel Blob: Access denied, please provide a valid token for this resource
 *
 * which reached QA as a 403 on BrandHub registration — and only when a logo
 * was attached, so it looked intermittent. A stale token was worse than none.
 *
 * Read at call time rather than captured at module load: these are serverless
 * handlers, and a value frozen at import survives a warm invocation after the
 * variable has been corrected.
 */
export function blobToken(): string | undefined {
  /*
   * The order is the whole correctness of this function, and it is not the
   * obvious one.
   *
   * Production carries TWO stores' credentials. `BLOB_PUBLIC_*` points at
   * store_OtYjc28v2vnxI85q, which is active and holds every logo this service
   * has ever written. `BLOB_READ_WRITE_TOKEN` points at
   * store_bsH8FnC9JQJc4VdU, which is not in the account's store list at all —
   * an older store, left behind.
   *
   * So the SDK's own name goes LAST here, against instinct. Preferring it
   * would silently move production's uploads to a store nothing reads, and
   * because a failed upload no longer fails a registration, nobody would see
   * it happen: brands would simply stop having logos.
   *
   * Prefixed names first, in the order the two backend projects use them.
   */
  return (
    // Production: the store the files are in.
    process.env.BLOB_PUBLIC_READ_WRITE_TOKEN?.trim() ||
    // Dev: the same store, connected with a different prefix.
    process.env.BLOB_DEV_READ_WRITE_TOKEN?.trim() ||
    // A local machine, or a project connected with no prefix at all. Last,
    // because on production this name belongs to the wrong store.
    process.env.BLOB_READ_WRITE_TOKEN?.trim() ||
    undefined
  );
}
