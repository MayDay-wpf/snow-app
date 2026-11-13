import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, MoveVertical } from "lucide-react";

import { useI18n } from "../../i18n";
import { getSshConnectionStatusLabel } from "../../ssh/sshConnectionStatus";
import { useSshWorkspaceGate } from "../../ssh/sshConnectionStore";
import type { GitFileStatus, GitStatusResult } from "./git";
import { GitControl, GitGraph, useGitRepos } from "./git";
import { openGitFileDiff } from "./git/openGitFileDiff";
import type { OpenDiffTabCallback } from "./types";
import type { RightPanelContentProps } from "./types";

const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;
const SPLIT_DEFAULT = 0.5;
/** 拖拽位移小于该值（px）时视为点击，用于切换提交图收起状态。 */
const DRAG_THRESHOLD = 4;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

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
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [splitRatio, setSplitRatio] = useState(SPLIT_DEFAULT);
  // 提交图区域是否收起：点击分隔条切换，收起时上方变更区占满，分隔条保留
  // 在原位供再次点击展开（展开后恢复收起前的高度比例）。
  const [graphCollapsed, setGraphCollapsed] = useState(false);
  // 提交图刷新键：手动刷新、提交 / 推送 / 拉取成功后自增，触发 GitGraph
  // 增量合并（历史被改写时它自行退回整体重载）。
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const changesRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const resumeFrameRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
      if (resumeFrameRef.current !== null) {
        cancelAnimationFrame(resumeFrameRef.current);
      }
      document.body.classList.remove("is-git-pane-resizing");
      changesRef.current?.style.removeProperty("transition");
      graphRef.current?.style.removeProperty("transition");
    },
    [],
  );

  const workspacePath = activeDirectory?.path ? activeDirectory.path : null;

  const {
    repos,
    selectedRepoPath,
    setSelectedRepoPath,
    phase,
    error: repoError,
    canOperate,
    identity,
    refresh: refreshRepos,
  } = useGitRepos(workspacePath);

  // 显式重连入口：连接被拦下（离线 / 认证失败等）时由状态卡片触发。
  const sshGate = useSshWorkspaceGate(activeDirectory);
  const sshGateLabel = sshGate.status
    ? getSshConnectionStatusLabel(t, sshGate.status)
    : "";

  const repoPath = selectedRepoPath;

  // 连接身份（工作区 + profile + 代际）或仓库变化时，旧 status 立即失效：
  // 其中的 currentBranch 属于上一个仓库 / 上一条连接。在渲染期间同步清空
  // （React 的「渲染期间调整 state」模式），新 status 由 GitControl 重新回报。
  const dataIdentity = `${identity}|${repoPath ?? ""}`;
  const [statusIdentity, setStatusIdentity] = useState(dataIdentity);
  if (statusIdentity !== dataIdentity) {
    setStatusIdentity(dataIdentity);
    setGitStatus(null);
  }

  /** 变更区/暂存区单击文件：在新的差异 tab 中打开（先加载态，再填充结果）。 */
  const handleFileSelect = useCallback(
    (file: GitFileStatus | null, section?: "staged" | "unstaged") => {
      if (!repoPath || !file || !onOpenInTab) {
        return;
      }
      // 单击来源优先：变更区 -> 工作区 diff；暂存区 -> `--cached` diff。
      // 同一文件同时存在于两个区域时，indexStatus 无法区分点击位置，
      // 必须以 section 为准。
      openGitFileDiff(repoPath, file, section === "staged", onOpenInTab);
    },
    [repoPath, onOpenInTab],
  );

  /** 历史可能已变化（手动刷新 / 提交 / 推送 / 拉取成功）：触发提交图刷新。 */
  const handleHistoryRefresh = useCallback(() => {
    setGraphRefreshKey((key) => key + 1);
  }, []);

  // 点击切换折叠；拖动以当前容器坐标计算位置，窗口尺寸变化时仍跟随指针。
  const startSplitResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0 || resizeCleanupRef.current) {
        return;
      }
      const container = containerRef.current;
      if (!container) {
        return;
      }
      event.preventDefault();
      if (resumeFrameRef.current !== null) {
        cancelAnimationFrame(resumeFrameRef.current);
        resumeFrameRef.current = null;
      }

      const resizer = event.currentTarget;
      const pointerId = event.pointerId;
      const startY = event.clientY;
      const wasCollapsed = graphCollapsed;
      const grabOffset = startY - resizer.getBoundingClientRect().top;
      let moved = false;

      const handlePointerMove = (pointerEvent: PointerEvent): void => {
        if (pointerEvent.pointerId !== pointerId) return;
        const deltaY = pointerEvent.clientY - startY;
        if (!moved) {
          if (
            Math.abs(deltaY) < DRAG_THRESHOLD ||
            (wasCollapsed && deltaY > 0)
          ) {
            return;
          }
          moved = true;
          // 禁止 flex-grow 过渡追赶指针，否则每帧都会出现视觉滞后和回弹。
          changesRef.current?.style.setProperty("transition", "none");
          graphRef.current?.style.setProperty("transition", "none");
          document.body.classList.add("is-git-pane-resizing");
          if (wasCollapsed) setGraphCollapsed(false);
        }
        const rect = container.getBoundingClientRect();
        const height = Math.max(
          1,
          container.clientHeight - resizer.offsetHeight,
        );
        const ratio = (pointerEvent.clientY - rect.top - grabOffset) / height;
        setSplitRatio(
          clamp(
            ratio,
            SPLIT_MIN,
            wasCollapsed ? 1 : Math.max(SPLIT_MAX, splitRatio),
          ),
        );
      };

      const cleanup = (): void => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
        document.removeEventListener("pointercancel", handlePointerCancel);
        window.removeEventListener("blur", cleanup);
        resizeCleanupRef.current = null;
        // 在最终一帧布局完成后再恢复过渡，避免松手时分割线反弹。
        resumeFrameRef.current = requestAnimationFrame(() => {
          document.body.classList.remove("is-git-pane-resizing");
          changesRef.current?.style.removeProperty("transition");
          graphRef.current?.style.removeProperty("transition");
          resumeFrameRef.current = null;
        });
      };
      const handlePointerUp = (pointerEvent: PointerEvent): void => {
        if (pointerEvent.pointerId !== pointerId) return;
        cleanup();
        if (!moved) setGraphCollapsed((prev) => !prev);
      };
      const handlePointerCancel = (pointerEvent: PointerEvent): void => {
        if (pointerEvent.pointerId === pointerId) cleanup();
      };

      resizeCleanupRef.current = cleanup;
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", handlePointerCancel);
      window.addEventListener("blur", cleanup);
    },
    [splitRatio, graphCollapsed],
  );

  return (
    <div className="git-panel-container" ref={containerRef}>
      <div
        ref={changesRef}
        className="git-panel-changes"
        style={{
          flexGrow: graphCollapsed ? 1 : splitRatio,
          flexBasis: 0,
          flexShrink: 0,
        }}
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
        {/* 扫描失败但保留了上次成功结果：明确提示数据可能过期，仍可继续操作。 */}
        {phase === "error" && repoPath ? (
          <div className="git-status-limit-hint" title={repoError ?? undefined}>
            <AlertTriangle size={13} strokeWidth={1.9} />
            <span>{t("git.repoScanFailed")}</span>
          </div>
        ) : null}
        {workspacePath === null ? (
          <div className="git-control">
            <div className="git-control-empty">
              {t("git.noWorkspaceDirectory")}
            </div>
          </div>
        ) : !canOperate ? (
          // 远程连接不可用：数据子树整体卸载，避免状态轮询与操作继续发请求。
          <div className="git-control">
            <div className="git-control-state">
              <span>
                {phase === "waiting"
                  ? t("git.waitingConnection", {
                      defaultValue: "Waiting for the SSH connection...",
                    })
                  : t("git.connectionUnavailable", {
                      values: { status: sshGateLabel },
                      defaultValue: "SSH connection unavailable",
                    })}
              </span>
              <button
                type="button"
                className="git-control-state-btn"
                onClick={sshGate.requestConnection}
              >
                {t("git.reconnect", { defaultValue: "Reconnect" })}
              </button>
            </div>
          </div>
        ) : !repoPath && phase === "scanning" ? (
          <div className="git-control">
            <div className="git-control-loading">
              {t("git.scanningRepos", {
                defaultValue: "Scanning for git repositories...",
              })}
            </div>
          </div>
        ) : !repoPath && phase === "error" ? (
          <div className="git-control">
            <div className="git-control-state is-error">
              <span title={repoError ?? undefined}>
                {t("git.repoScanFailed")}
              </span>
              <button
                type="button"
                className="git-control-state-btn"
                onClick={() => void refreshRepos()}
              >
                {t("git.retry", { defaultValue: "Retry" })}
              </button>
            </div>
          </div>
        ) : !repoPath ? (
          <div className="git-control">
            <div className="git-control-state">
              <span>{t("git.noReposFound")}</span>
              <button
                type="button"
                className="git-control-state-btn"
                onClick={() => void refreshRepos()}
              >
                {t("git.retry", { defaultValue: "Retry" })}
              </button>
            </div>
          </div>
        ) : (
          <GitControl
            key={dataIdentity}
            repoPath={repoPath}
            directoryId={activeDirectory?.directoryId}
            repos={repos}
            onRepoSelect={setSelectedRepoPath}
            onFileSelect={handleFileSelect}
            onStatusChange={setGitStatus}
            onOpenFile={onOpenFile}
            onOpenTerminal={onOpenTerminal}
            onHistoryRefresh={handleHistoryRefresh}
            onRediscoverRepos={refreshRepos}
          />
        )}
      </div>

      <div
        className="h-resizer"
        role="separator"
        aria-label={t("rightPanel.resizeChangesAndGraph")}
        aria-orientation="horizontal"
        aria-expanded={!graphCollapsed}
        aria-controls="git-panel-commit-graph"
        aria-valuemin={15}
        aria-valuemax={100}
        aria-valuenow={Math.round((graphCollapsed ? 1 : splitRatio) * 100)}
        aria-valuetext={
          graphCollapsed
            ? t("rightPanel.expandCommitGraph")
            : `${Math.round(splitRatio * 100)}%`
        }
        tabIndex={0}
        title={
          graphCollapsed
            ? t("rightPanel.expandCommitGraph")
            : t("rightPanel.collapseCommitGraph")
        }
        onPointerDown={startSplitResize}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setGraphCollapsed((prev) => !prev);
          }
        }}
      >
        <MoveVertical className="h-resizer-icon" size={12} />
      </div>

      <div
        className="git-panel-graph"
        style={{
          flexGrow: graphCollapsed ? 0 : 1 - splitRatio,
          flexBasis: 0,
          flexShrink: 0,
        }}
      >
        {repoPath && canOperate ? (
          <GitGraph
            key={dataIdentity}
            repoPath={repoPath}
            directoryId={activeDirectory?.directoryId}
            branch={gitStatus?.currentBranch ?? null}
            refreshKey={graphRefreshKey}
            onOpenInTab={onOpenInTab}
          />
        ) : (
          <div className="git-graph-empty">
            {t("rightPanel.noRepositorySelected")}
          </div>
        )}
      </div>
    </div>
  );
}
