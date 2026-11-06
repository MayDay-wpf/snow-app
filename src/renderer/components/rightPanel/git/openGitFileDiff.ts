import type { GitDiffResult, GitFileStatus } from "../../../../preload";
import type { OpenDiffTabCallback } from "../types";

/** 已知二进制格式不生成文本 patch；其他文件仍由 Git 的内容检测最终判定。 */
const BINARY_DIFF_EXTENSIONS =
  /\.(?:png|jpe?g|gif|bmp|webp|ico|tiff?|avif|pdf|zip|rar|7z|tar|gz|bz2|xz|exe|dll|so|dylib|bin|class|jar|wasm|db|sqlite3?|woff2?|ttf|otf|mp[34]|mov|avi|mkv|wav|flac)$/i;

/** 打开文本差异；已知二进制文件及 Git 检出的二进制内容只显示不可查看提示。 */
export const openGitFileDiff = (
  repoPath: string,
  file: GitFileStatus,
  staged: boolean,
  onOpenInTab: OpenDiffTabCallback,
): void => {
  if (BINARY_DIFF_EXTENSIONS.test(file.path)) {
    onOpenInTab(file, { content: "", isBinary: true, error: "" }, false);
    return;
  }

  onOpenInTab(file, null, true);
  window.snow
    .gitFileDiff(repoPath, file.path, staged)
    .then((result) => onOpenInTab(file, result, false))
    .catch((err: unknown) => {
      // 请求失败时给出可见错误，而不是退化成「没有可显示的变更」
      const failure: GitDiffResult = {
        content: "",
        isBinary: false,
        error: err instanceof Error ? err.message : String(err),
      };
      onOpenInTab(file, failure, false);
    });
};
