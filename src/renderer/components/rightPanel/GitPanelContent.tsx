import { useCallback, useEffect, useRef, useState } from "react";
import { MoveVertical } from "lucide-react";

import { useI18n } from "../../i18n";
import { DiffViewer } from "./DiffViewer";
import type {
  GitCommitFile,
  GitDiffResult,
  GitFileStatus,
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
  // 当 diff 来自提交树（GitGraph）时记录提交 hash，diff 加载走
  // gitCommitFileDiff 而不是工作区 diff。
  const [commitFileSelection, setCommitFileSelection] = useState<{
    hash: string;
    file: GitCommitFile;
  } | null>(null);
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
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
      return;
    }

    setDiffLoading(true);
    const isStaged =
      selectedFile.indexStatus !== " " &&
      selectedFile.indexStatus !== "?" &&
      selectedFile.indexStatus !== "";

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
  }, [repoPath, selectedFile, commitFileSelection]);

  /** 提交树中点击提交内文件：显示该提交中该文件的差异。 */
  const handleCommitFileSelect = useCallback(
    (file: GitCommitFile, hash: string) => {
      setSelectedFile(toGitFileStatus(file));
      setCommitFileSelection({ hash, file });
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
        <GitControl
          repoPath={repoPath}
          repos={repos}
          onRepoSelect={setSelectedRepoPath}
          onFileSelect={setSelectedFile}
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
            onOpenInTab={onOpenInTab}
            onClose={() => setSelectedFile(null)}
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
