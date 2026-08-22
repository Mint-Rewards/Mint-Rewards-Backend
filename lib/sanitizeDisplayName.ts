/**
 * Normalise a user-supplied display name for use in email headers and bodies.
 *
 * escapeHtml (lib/escapeHtml.ts) covers HTML contexts. It does nothing for the
 * *subject line*, which is not HTML: a name containing CR or LF interpolated
 * into a subject is header-injection territory, and nothing in the send path
 * is assumed to strip it. This runs once, before any string is built, so the
 * subject, headline, intro, attribution and text part all consume one value.
 *
 * The 40-character cap is a layout constraint as much as a safety one — the
 * headline is a 26px H1 inside a fixed 600px table, and an unbounded name
 * blows the layout apart long before it becomes a delivery problem. Truncation
 * is hard, with no ellipsis: a trailing "…" on a real person's name reads as a
 * bug, whereas a plainly cut name reads as a long name.
 *
 * Returns undefined rather than "" for an input that sanitises away to
 * nothing, so callers fall through to their unnamed variant instead of
 * rendering a headline with a hole where the name should be. Whitespace-only
 * and control-character-only inputs both land here — and this collection holds
 * ordinary dirty free-text, not merely adversarial input.
 */
const MAX_DISPLAY_NAME_LENGTH = 40;

// C0 (00-1F, which includes CR and LF), DEL (7F), and C1 (80-9F).
//
// no-control-regex fires on exactly the characters this is here to strip:
// matching CR and LF is the point, since a name carrying either reaches an
// email subject line as header injection.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F-\x9F]/g;

export function sanitizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const cleaned = value
    // Control characters become spaces rather than being deleted, so
    // "Ada\nLovelace" reads as two words instead of fusing into "AdaLovelace".
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    // A cut landing mid-gap would otherwise leave a trailing space.
    .trim();

  return cleaned === "" ? undefined : cleaned;
}

export default sanitizeDisplayName;
