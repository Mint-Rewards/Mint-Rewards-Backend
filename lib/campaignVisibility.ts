/**
 * True if `campaign` should be shown to a user whose profile city is
 * `userCity`.
 *
 * Rules:
 *   - campaign.cities empty/absent  => untargeted, visible to everyone
 *   - user has no city set          => only untargeted campaigns are visible
 *   - otherwise                     => visible iff userCity is in campaign.cities
 */
export function isCampaignVisibleToCity(
  campaign: { cities?: string[] | null },
  userCity?: string | null,
): boolean {
  const cities = campaign.cities;
  if (!cities || cities.length === 0) return true;
  if (!userCity) return false;
  const normalize = (v: string) => v.trim().toLowerCase();
  const normalizedUserCity = normalize(userCity);
  return cities.some((c) => normalize(c) === normalizedUserCity);
}
