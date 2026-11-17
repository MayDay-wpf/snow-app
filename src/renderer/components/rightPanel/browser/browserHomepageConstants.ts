export const BROWSER_HOMEPAGE_SETTING_NAME = "Browser homepage";
export const BROWSER_HOMEPAGE_SETTING_CODE = "browser_homepage";

/** 未设置时默认空白页 */
export const DEFAULT_BROWSER_HOMEPAGE = "";

/** 起始页留空时打开的空白页 */
export const BLANK_PAGE_URL = "about:blank";

/**
 * Normalize raw storage value into a valid homepage URL string.
 * Empty string is allowed (means "blank page").
 */
export const normalizeBrowserHomepage = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_BROWSER_HOMEPAGE;
  }
  const trimmed = value.trim();
  // Allow empty — means no homepage (blank page)
  if (!trimmed) {
    return "";
  }
  return trimmed;
};

export const readBrowserHomepageJson = (value: string | null): string => {
  if (!value) {
    return DEFAULT_BROWSER_HOMEPAGE;
  }
  try {
    return normalizeBrowserHomepage(JSON.parse(value));
  } catch {
    return DEFAULT_BROWSER_HOMEPAGE;
  }
};
