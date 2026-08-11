import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, MoveVertical } from "lucide-react";

import { useI18n } from "../../i18n";
import { DiffViewer } from "./DiffViewer";
import type {
  GitCommitFile,
  GitDiffResult,
  GitFileStatus,
  GitImageDiff,
  GitStatusResult,
} from "./git";
import { GitControl, RepoSelector, useGitRepos } from "./git";
import type { OpenDiffTabCallback } from "./types";
import type { RightPanelContentProps } from "./types";

const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;
const SPLIT_DEFAULT = 0.5;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** 与 Rust 端 / SSH 端保持一致的图片扩展名判定。 */
const IMAGE_FILE_REGEX = /\.(png|jpe?g|gif|bmp|webp|ico|svg|tiff?|avif)$/i;

const isImageFile = (path: string): boolean => IMAGE_FILE_REGEX.test(path);

/** 将提交文件（GitCommitFile）转换为 DiffViewer 所需的 GitFileStatus 形状。 */
const toGitFileStatus = (file: GitCommitFile): GitFileStatus => ({
  path: file.path,
  oldPath: null,
  indexStatus: "",
  workdirStatus: "",
  status: file.status,
});

export function GitPanelContent({
  activeDirectory,
  onOpenInTab,
  onOpenFile,
  onOpenTerminal,
}: RightPanelContentProps & {
  onOpenInTab?: OpenDiffTabCallback;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onOpenTerminal?: (cwd: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [selectedFile, setSelectedFile] = useState<GitFileStatus | null>(null);
  // 选中文件来自变更区还是暂存区。同一路径可能同时出现在两个区域，
  // 必须用点击来源决定 diff 类型（工作区 diff vs `--cached` 暂存区 diff），
  // 而不能靠 indexStatus 推断。
  const [selectedSection, setSelectedSection] = useState<
    "staged" | "unstaged" | null
  >(null);
  // 当 diff 来自提交树（GitGraph）时记录提交 hash，diff 加载走
  // gitCommitFileDiff 而不是工作区 diff。parentHash 用于图片对比的
  // 旧版本（第一个父提交）。
  const [commitFileSelection, setCommitFileSelection] = useState<{
    hash: string;
    parentHash: string | null;
    file: GitCommitFile;
  } | null>(null);
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [imageDiff, setImageDiff] = useState<GitImageDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [splitRatio, setSplitRatio] = useState(SPLIT_DEFAULT);
  const containerRef = useRef<HTMLDivElement>(null);

  const workspacePath = activeDirectory?.path ? activeDirectory.path : null;

  const { repos, selectedRepoPath, setSelectedRepoPath } =
    useGitRepos(workspacePath);

  const repoPath = selectedRepoPath;

  // Fetch diff when a file is selected
  useEffect(() => {
    if (!repoPath || !selectedFile) {
      setDiffResult(null);
      setImageDiff(null);
      return;
    }

    setDiffLoading(true);
    // 点击来源优先：变更区 -> 工作区 diff；暂存区 -> `--cached` diff。
    // 同一文件同时存在于两个区域时，indexStatus 无法区分点击位置，
    // 必须以 selectedSection 为准。
    const isStaged = selectedSection === "staged";

    // 图片文件：渲染旧/新版本图片而非文本 diff。
    // 文本 diff 对图片会因二进制 --text 重试产生巨大乱码 patch 而卡死，
    // 因此图片路径完全不请求 gitFileDiff。
    if (isImageFile(selectedFile.path)) {
      setDiffResult(null);
      const untracked = selectedFile.indexStatus === "?";

      // 确定旧/新版本的读取来源：
      // - 提交树场景：新=该提交，旧=第一个父提交（无父则为新增）
      // - 已暂存：旧=HEAD，新=索引(:0)
      // - 未暂存已跟踪：旧=HEAD，新=工作区磁盘
      // - 未跟踪（新增）：只有新=工作区磁盘；删除文件磁盘读取失败→只有旧
      let oldRevision: string | null = null;
      let newRevision: string | null = null;
      if (commitFileSelection) {
        newRevision = commitFileSelection.hash;
        oldRevision = commitFileSelection.parentHash;
      } else if (isStaged) {
        oldRevision = "HEAD";
        newRevision = ":0";
      } else if (!untracked) {
        oldRevision = "HEAD";
        newRevision = null; // 工作区磁盘
      } else {
        newRevision = null; // 工作区磁盘
      }

      void Promise.all([
        oldRevision
          ? window.snow
              .gitFileContent(repoPath, selectedFile.path, oldRevision)
              .catch(() => null)
          : Promise.resolve(null),
        newRevision
          ? window.snow
              .gitFileContent(repoPath, selectedFile.path, newRevision)
              .catch(() => null)
          : Promise.resolve(null),
      ])
        .then(([oldContent, newContent]) => {
          setImageDiff({ old: oldContent, new: newContent });
        })
        .finally(() => {
          setDiffLoading(false);
        });
      return;
    }

    const diffPromise = commitFileSelection
      ? window.snow.gitCommitFileDiff(
          repoPath,
          commitFileSelection.hash,
          selectedFile.path
        )
      : window.snow.gitFileDiff(repoPath, selectedFile.path, isStaged);

    diffPromise
      .then((result) => {
        setDiffResult(result);
      })
      .catch(() => {
        setDiffResult(null);
      })
      .finally(() => {
        setDiffLoading(false);
      });
  }, [repoPath, selectedFile, commitFileSelection, selectedSection]);

  /** 变更区/暂存区点击文件：记录文件与其来源区域。 */
  const handleFileSelect = useCallback(
    (file: GitFileStatus | null, section?: "staged" | "unstaged") => {
      setSelectedFile(file);
      setSelectedSection(section ?? null);
    },
    []
  );

  /** 提交树中点击提交内文件：显示该提交中该文件的差异。 */
  const handleCommitFileSelect = useCallback(
    (file: GitCommitFile, hash: string, parentHash: string | null) => {
      setSelectedFile(toGitFileStatus(file));
      setSelectedSection(null);
      setCommitFileSelection({ hash, parentHash, file });
    },
    []
  );

  const startSplitResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const startY = event.clientY;
      const containerHeight = container.clientHeight;
      const startRatio = splitRatio;

      const handlePointerMove = (pointerEvent: PointerEvent): void => {
        const deltaY = pointerEvent.clientY - startY;
        const newRatio = startRatio + deltaY / containerHeight;
        setSplitRatio(clamp(newRatio, SPLIT_MIN, SPLIT_MAX));
      };

      const stopResize = (): void => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", stopResize);
        document.removeEventListener("pointercancel", stopResize);
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", stopResize);
      document.addEventListener("pointercancel", stopResize);
    },
    [splitRatio]
  );

  return (
    <div className="git-panel-container" ref={containerRef}>
      <div
        className="git-panel-changes"
        style={{ flexGrow: splitRatio, flexBasis: 0, flexShrink: 0 }}
      >
        {gitStatus?.statusLimitHit ? (
          <div className="git-status-limit-hint">
            <AlertTriangle size={13} strokeWidth={1.9} />
            <span>
              {t("git.statusLimitHit", {
                defaultValue:
                  "Too many changes to display, only part of them are shown.",
              })}
            </span>
          </div>
        ) : null}
        <GitControl
          repoPath={repoPath}
          repos={repos}
          onRepoSelect={setSelectedRepoPath}
          onFileSelect={handleFileSelect}
          onCommitFileSelect={handleCommitFileSelect}
          onStatusChange={setGitStatus}
          onOpenFile={onOpenFile}
          onOpenTerminal={onOpenTerminal}
          onOpenInTab={onOpenInTab}
        />
      </div>

      <div
        className="h-resizer"
        role="separator"
        aria-label={t("rightPanel.resizeChangesAndDiff")}
        aria-orientation="horizontal"
        onPointerDown={startSplitResize}
      >
        <MoveVertical className="h-resizer-icon" size={12} />
      </div>

      <div
        className="git-panel-diff"
        style={{ flexGrow: 1 - splitRatio, flexBasis: 0, flexShrink: 0 }}
      >
        {selectedFile ? (
          <DiffViewer
            selectedFile={selectedFile}
            diffResult={diffResult}
            diffLoading={diffLoading}
            imageDiff={imageDiff}
            onOpenInTab={onOpenInTab}
            onClose={() => {
              setSelectedFile(null);
              setCommitFileSelection(null);
            }}
          />
        ) : (
          <div className="diff-viewer">
            <div className="diff-viewer-empty">
              {gitStatus
                ? t("rightPanel.selectFileToViewDiff")
                : t("rightPanel.noRepositorySelected")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
