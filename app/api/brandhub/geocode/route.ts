/**
 * Place lookup for the BrandHub pin picker.
 *
 * Nominatim answers a server-side request carrying an identifying User-Agent
 * but 403s the same request from a browser — their policy blocks web apps that
 * do not identify themselves. So the browser cannot call it and this is the
 * server that does it on the brand's behalf.
 *
 * NOT the ops console's proxy at /geocode on the admin API, which is guarded
 * by an admin JWT. A brand holds a brand token and will never hold that one,
 * and widening that route's auth to admit brands would make an internal tool's
 * endpoint public to every partner.
 *
 * Authenticated all the same. An open proxy could be hammered under our
 * User-Agent until Nominatim blocked it, which would take the ops console's
 * search down with it.
 */
import { type NextRequest, NextResponse } from "next/server";
import { requireBrandAuth } from "@/lib/requireBrandAuth";

const HEADERS = {
  "user-agent": "MintRewardsBrandHub/1.0 (partner dashboard)",
  "accept-language": "en",
};

/** A phone on a slow connection still gives up before the dialog looks hung. */
const TIMEOUT_MS = 8000;

export interface PlaceHit {
  label: string;
  lat: number;
  lng: number;
}

export async function GET(req: NextRequest) {
  const auth = requireBrandAuth(req);
  if (auth instanceof NextResponse) return auth;

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  // Two characters match half a city and cost a request against a one-per-
  // second budget. The client searches on submit, not per keystroke, for the
  // same reason.
  if (q.length < 3) return NextResponse.json({ places: [] });

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("addressdetails", "1");
  /*
   * Pakistan only. Every zone is here, and an unqualified "Clifton" otherwise
   * returns Bristol first — which a brand would click, and then wonder why no
   * van came.
   */
  url.searchParams.set("countrycodes", "pk");

  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: "Place search is unavailable just now." },
        { status: 502 },
      );
    }
    const raw = (await res.json()) as {
      display_name?: string;
      lat?: string;
      lon?: string;
    }[];

    const places: PlaceHit[] = raw
      .map((p) => ({
        label: p.display_name ?? "",
        lat: Number(p.lat),
        lng: Number(p.lon),
      }))
      .filter((p) => p.label && Number.isFinite(p.lat) && Number.isFinite(p.lng));

    return NextResponse.json({ places });
  } catch {
    // Timeout or network. A dead search must not read as "no such place",
    // which would send a brand hunting for a spelling that was never wrong.
    return NextResponse.json(
      { error: "Place search is unavailable just now." },
      { status: 502 },
    );
  }
}
