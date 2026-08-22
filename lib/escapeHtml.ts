/**
 * Escape a string for interpolation into HTML text or a double-quoted
 * attribute value.
 *
 * Lives in its own module because the email templates are the second caller
 * that needs it and will not be the last — emailServices/profileNotComplete.ts
 * interpolates a user-controlled `userName` raw today and wants this.
 *
 * Ampersand is replaced first: doing it later would re-escape the ampersands
 * introduced by the other four replacements, turning `<` into `&amp;lt;`.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default escapeHtml;
