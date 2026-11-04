import { localPathToFileUrl } from "../../../../utils/browserFileOpen";
import { localFileUrlToPath } from "../../../../utils/localFileUrl";

/** Only local paths or the conversation's own SSH authority; never the app URL base. */
export const resolveArtifactPath = (
  raw: string,
  workspace: string | undefined,
): string | undefined => {
  const remote = workspace?.startsWith("ssh://") ?? false;
  if (!raw || /[\u0000-\u001f]/.test(raw) || /^[\\/]{2}/.test(raw)) return;
  let path = raw;
  if (/^ssh:\/\//i.test(path)) {
    if (
      !remote ||
      path.match(/^ssh:\/\/[^/]+/i)?.[0] !==
        workspace?.match(/^ssh:\/\/[^/]+/i)?.[0]
    )
      return;
    path = path.replace(/^ssh:\/\/[^/]+/i, "");
  }
  if (/^file:/i.test(path)) {
    if (remote) return;
    const local = localFileUrlToPath(path);
    if (!local) return;
    path = local;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return;
  if (!/\.html?$/i.test(path)) return;
  if (remote) {
    if (/^[a-z]:/i.test(path) || path.includes("\\")) return;
    const root = workspace!.replace(/^ssh:\/\/[^/]+/, "");
    // URL resolves dot segments; encode each segment so spaces and percent names stay literal.
    const absolute = path.startsWith("/")
      ? path
      : `${root.replace(/\/$/, "")}/${path}`;
    return decodeURIComponent(
      new URL(
        absolute.split("/").map(encodeURIComponent).join("/"),
        "https://artifact.invalid",
      ).pathname,
    );
  }
  if (!/^(?:\/|[a-z]:[\\/])/i.test(path)) {
    if (!workspace) return;
    path = `${workspace.replace(/[\\/]+$/, "")}/${path}`;
  }
  const url = localPathToFileUrl(path);
  return url ? localFileUrlToPath(url) : undefined;
};

/** URI decorations are not filename characters; encoded %23/%3F remain literal after decoding. */
export const resolveArtifactHref = (
  href: string,
  workspace: string | undefined,
): string | undefined => {
  const pathname = href.trim().split(/[?#]/, 1)[0];
  try {
    return resolveArtifactPath(
      /^file:/i.test(pathname) ? pathname : decodeURIComponent(pathname),
      workspace,
    );
  } catch {
    return;
  }
};
