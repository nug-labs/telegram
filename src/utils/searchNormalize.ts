/**
 * Primary lookup string for NugLabs `getStrain` (matches SDK: trim + lowercase,
 * collapses whitespace). Only strips a leading `#` (Telegram hashtag), so names
 * like "Gelato #33" stay "gelato #33" and still match the catalogue.
 */
export function preparePrimaryStrainLookup(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^#+/, "");
}

/**
 * Loose comparison: strips all `#`, so "gelato 33", "Gelato #33", "gelato#33"
 * align with the same key. Use for fallback matching and inline ranking when
 * the catalogue uses `#` in the official name.
 */
export function normalizeForLooseStrainMatch(value: string): string {
  return value
    .replace(/#/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function normalizeForLooseStrainMatchNoSpaces(value: string): string {
  return normalizeForLooseStrainMatch(value).replace(/\s+/g, "");
}

/** @deprecated Prefer preparePrimaryStrainLookup / loose helpers; kept for clarity in imports */
export const normalizeForSearch = normalizeForLooseStrainMatch;

export function normalizeForSearchNoSpaces(value: string): string {
  return normalizeForLooseStrainMatchNoSpaces(value);
}
