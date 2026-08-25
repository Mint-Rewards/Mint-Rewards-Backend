import connectToDatabase from "@/lib/mongodb";
import { getAuthenticatedUserId } from "@/lib/auth";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { serverEnv } from "@/lib/env";
import { resolveGeocodedName } from "@/lib/locationRegistry";
import GeocodeCacheModel, { geocodeCacheKey } from "@/lib/geocodeCache";

// LocationIQ's `address` object shape is loosely documented and inconsistent
// about which key actually carries the locality — see deriveGeocodeFields.
// Every field is optional and untyped beyond "maybe a string".
interface LocationIqAddress {
  city?: unknown;
  town?: unknown;
  municipality?: unknown;
  suburb?: unknown;
  city_district?: unknown;
  neighbourhood?: unknown;
  residential?: unknown;
  [key: string]: unknown;
}

interface ReverseGeocodeResult {
  resolved: boolean;
  cityName: string | null;
  areaName: string | null;
  blockHint: string | null;
  raw: Record<string, unknown> | null;
  unmatched: string[];
}

const EMPTY_RESULT: ReverseGeocodeResult = {
  resolved: false,
  cityName: null,
  areaName: null,
  blockHint: null,
  raw: null,
  unmatched: [],
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Derives {cityName, areaName, blockHint, unmatched} from a LocationIQ
 * `address` object. Pure function of `address` alone — used both right after
 * a live fetch (to decide what gets cached) and, identically, to build the
 * response for a fresh fetch. A cache HIT does NOT call this again; see the
 * comment in POST below for why.
 */
function deriveGeocodeFields(
  address: LocationIqAddress,
): Omit<ReverseGeocodeResult, "resolved" | "raw"> {
  const cityName =
    asNonEmptyString(address.city) ??
    asNonEmptyString(address.town) ??
    asNonEmptyString(address.municipality);

  // Tried IN ORDER; the response is inconsistent about which key carries the
  // locality, so each candidate is tried in turn until one resolves through
  // the registry. Every candidate tried before a hit (or all of them, on a
  // total miss) is recorded in `unmatched` and logged — this is the alias
  // backlog feed.
  const candidates = [
    address.suburb,
    address.city_district,
    address.neighbourhood,
  ];

  let areaName: string | null = null;
  const unmatched: string[] = [];

  for (const raw of candidates) {
    const candidate = asNonEmptyString(raw);
    if (!candidate) continue;

    const resolved = resolveGeocodedName(candidate, cityName ?? undefined);
    if (resolved) {
      areaName = resolved.town;
      break;
    }

    unmatched.push(candidate);
    console.warn(`[geocode-unmatched] ${candidate}`);
  }

  // Nullish-coalescing per the brief: neighbourhood first, then residential.
  // A hint only — NEVER written to any canonical field by this route or any
  // caller of it.
  const blockHint =
    (typeof address.neighbourhood === "string"
      ? address.neighbourhood
      : undefined) ??
    (typeof address.residential === "string"
      ? address.residential
      : undefined) ??
    null;

  return { cityName, areaName, blockHint, unmatched };
}

export async function POST(req: Request) {
  try {
    await connectToDatabase();

    const userId = await getAuthenticatedUserId({
      headers: {
        authorization: req.headers.get("authorization") ?? undefined,
      },
    });

    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const limit = await checkRateLimit(
      "reverse-geocode",
      userId,
      20,
      3_600_000,
    );
    if (limit.limited) return rateLimitResponse(limit.retryAfterSeconds);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const { lat, lng } =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    if (
      typeof lat !== "number" ||
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90
    ) {
      return Response.json(
        { error: "lat must be a finite number between -90 and 90." },
        { status: 400 },
      );
    }
    if (
      typeof lng !== "number" ||
      !Number.isFinite(lng) ||
      lng < -180 ||
      lng > 180
    ) {
      return Response.json(
        { error: "lng must be a finite number between -180 and 180." },
        { status: 400 },
      );
    }

    // Unset key: every call answers `{ resolved: false }` without touching
    // the cache at all — no read, no write, no fetch. The key never reaches
    // this route's response body in any path below either.
    const apiKey = serverEnv.locationIqApiKey;
    if (!apiKey) {
      return Response.json(EMPTY_RESULT);
    }

    const cacheKey = geocodeCacheKey(lat, lng);
    const cached = await GeocodeCacheModel.findById(cacheKey).lean();

    if (cached) {
      // Cache hit: serve the materialized fields written at cache-write time
      // WITHOUT re-deriving from `raw`. Re-deriving would re-log every still-
      // unmatched candidate via console.warn on every repeat hit for a
      // popular cell — noise the alias backlog feed does not need, since
      // deriveGeocodeFields already ran (and warned) once, on the write that
      // populated this entry.
      return Response.json({
        resolved: cached.areaName !== null,
        cityName: cached.cityName,
        areaName: cached.areaName,
        blockHint: cached.blockHint,
        raw: cached.raw,
        unmatched: [],
      } satisfies ReverseGeocodeResult);
    }

    const url =
      `https://us1.locationiq.com/v1/reverse?key=${encodeURIComponent(apiKey)}` +
      `&lat=${lat}&lon=${lng}&format=json&addressdetails=1&zoom=16`;

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    } catch {
      // Fetch rejection or timeout. Never a 5xx from this route, and never
      // cached — only a successful LocationIQ response is cached.
      return Response.json(EMPTY_RESULT);
    }

    if (!response.ok) {
      return Response.json(EMPTY_RESULT);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return Response.json(EMPTY_RESULT);
    }

    const address =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).address === "object" &&
      (payload as Record<string, unknown>).address !== null
        ? ((payload as Record<string, unknown>)
            .address as LocationIqAddress)
        : null;

    if (!address) {
      return Response.json(EMPTY_RESULT);
    }

    const derived = deriveGeocodeFields(address);

    // Only successful LocationIQ responses are cached — this point is only
    // reached on a 200 with a usable `address` object.
    await GeocodeCacheModel.updateOne(
      { _id: cacheKey },
      {
        $set: {
          raw: address,
          cityName: derived.cityName,
          areaName: derived.areaName,
          blockHint: derived.blockHint,
          resolvedAt: new Date(),
        },
      },
      { upsert: true },
    );

    return Response.json({
      resolved: derived.areaName !== null,
      cityName: derived.cityName,
      areaName: derived.areaName,
      blockHint: derived.blockHint,
      raw: address as Record<string, unknown>,
      unmatched: derived.unmatched,
    } satisfies ReverseGeocodeResult);
  } catch {
    return Response.json(
      { error: "Your request could not be processed. Please try again." },
      { status: 500 },
    );
  }
}
