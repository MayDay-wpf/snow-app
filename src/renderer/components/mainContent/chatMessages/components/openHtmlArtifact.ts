import { rightPanelEvents } from "../../../rightPanel/rightPanelEvents";
import { openBrowserFile } from "../../../../utils/browserFileOpen";
import { HTML_ARTIFACT_MAX_BYTES } from "../../../../../shared/htmlArtifact";
import { resolveArtifactPath } from "./chatFileArtifacts";

/** SSH 远程 HTML 没有本地 file://：读出内容写入本地预览缓存后再交给内置浏览器。 */
const openRemoteHtml = async (
  workspace: string,
  remotePath: string,
): Promise<void> => {
  try {
    const result = await window.snow.sshReadFile(workspace, remotePath);
    if (result.isBinary || result.content.includes("\u0000")) return;
    if (
      result.size > HTML_ARTIFACT_MAX_BYTES ||
      new TextEncoder().encode(result.content).byteLength >
        HTML_ARTIFACT_MAX_BYTES
    ) {
      return;
    }
    const prepared = await window.snow.prepareHtmlPreview(result.content);
    rightPanelEvents.emit("open-browser-tab", { url: prepared.fileUrl });
  } catch (error) {
    console.error("[html-artifact] open in browser failed:", error);
  }
};

/**
 * 在内置浏览器中打开 HTML 文件，返回是否已受理（路径无法解析 / 非网页文件时为 false）。
 * 本地文件走 file://，SSH 远程文件走本地预览缓存。
 */
export const openHtmlArtifact = (
  rawPath: string,
  workspace: string | undefined,
): boolean => {
  const path = resolveArtifactPath(rawPath, workspace);
  if (!path) {
    return false;
  }
  if (workspace?.startsWith("ssh://")) {
    void openRemoteHtml(workspace, path);
    return true;
  }
  return openBrowserFile(path);
};
