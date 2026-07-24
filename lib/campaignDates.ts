// Shared campaign active-date semantics.
//
// Campaign startDate/endDate are stored as loosely-typed strings (often
// date-only "YYYY-MM-DD", sometimes empty or an ISO timestamp). This helper
// parses them as real Dates so callers stop doing lexicographic string
// comparisons, which break on mixed/empty formats.
//
// Rules:
//   - missing/invalid startDate => treat as already started
//   - missing/invalid endDate   => never expires
//   - a date-only endDate is inclusive through the end of that day
//     (23:59:59.999 local), so a coupon is still active on its last day.

/** Parse a stored date string into a Date, or null if missing/invalid. */
function parseDate(value?: string | null): Date | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** True for a bare "YYYY-MM-DD" string with no time component. */
function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

export function isCampaignActive(
  campaign: { startDate?: string | null; endDate?: string | null },
  now: Date = new Date(),
): boolean {
  const start = parseDate(campaign.startDate);
  // Missing/invalid start => already started.
  if (start && now < start) return false;

  const end = parseDate(campaign.endDate);
  // Missing/invalid end => never expires.
  if (!end) return true;

  // Date-only end dates are inclusive through the end of that day. Parse the
  // Y/M/D straight from the string so the day boundary is not shifted by the
  // UTC-midnight interpretation of "YYYY-MM-DD".
  if (typeof campaign.endDate === "string" && isDateOnly(campaign.endDate)) {
    const [y, m, d] = campaign.endDate.trim().split("-").map(Number);
    const endOfDay = new Date(y, m - 1, d, 23, 59, 59, 999);
    return now <= endOfDay;
  }

  return now <= end;
}
