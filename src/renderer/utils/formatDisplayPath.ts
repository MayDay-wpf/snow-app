/** Format a physical path for display without changing the value used by APIs. */
export const formatDisplayPath = (path: string): string =>
  path
    .replace(/^([\\/]{2})\\?[\\/]UNC[\\/]/i, "$1")
    .replace(/^[\\/]{2}\\?[\\/](?=[a-z]:[\\/])/i, "");

/** Normalize a physical path for identity comparisons: strip the Windows verbatim
 *  prefix, unify separators, drop the trailing slash and compare case-insensitively. */
export const normalizePathForCompare = (path: string): string =>
  formatDisplayPath(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
