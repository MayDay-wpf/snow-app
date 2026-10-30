/** Format a physical path for display without changing the value used by APIs. */
export const formatDisplayPath = (path: string): string =>
  path
    .replace(/^([\\/]{2})\?[\\/]UNC[\\/]/i, "$1")
    .replace(/^[\\/]{2}\?[\\/](?=[a-z]:[\\/])/i, "");
