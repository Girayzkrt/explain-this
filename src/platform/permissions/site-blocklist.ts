import type { ReadingPreferences } from "../../features/settings/settings";

export const isSiteBlocked = (
  pageUrl: string,
  blockedSites: ReadingPreferences["blockedSites"],
): boolean => {
  const pageHostname = getPageHostname(pageUrl);
  if (!pageHostname) return true;

  return blockedSites
    .map(normalizeBlockedHostname)
    .filter((hostname): hostname is string => hostname !== undefined)
    .some(
      (blockedHostname) =>
        pageHostname === blockedHostname ||
        pageHostname.endsWith(`.${blockedHostname}`),
    );
};

const getPageHostname = (pageUrl: string): string | undefined => {
  try {
    const page = new URL(pageUrl);
    if (page.protocol !== "http:" && page.protocol !== "https:") return undefined;
    return page.hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const normalizeBlockedHostname = (value: string): string | undefined => {
  const candidate = value.trim();
  if (!candidate || /[/:?#@]/.test(candidate)) return undefined;

  try {
    return new URL(`https://${candidate}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};
