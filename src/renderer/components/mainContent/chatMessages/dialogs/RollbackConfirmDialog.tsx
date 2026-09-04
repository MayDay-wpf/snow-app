import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Eye,
  FileX2,
  ListChecks,
  Loader2,
  Workflow,
} from "lucide-react";
import type {
  CheckpointFileChange,
  CheckpointFileDiff,
} from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { useEscapeKey } from "../../../../hooks/useEscapeKey";
import type {
  RollbackMemoryItem,
  RollbackMode,
  RollbackTodoItem,
} from "../utils/conversationTypes";
import {
  FileChangeIcon,
  FileDiffPreview,
  getFileChangeClassName,
} from "../../../common/FileDiffPreview";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import { getFileName } from "../toolCalls/shared/formatters";

type RollbackConfirmDialogProps = {
  changes: CheckpointFileChange[];
  checkpointIds: string[];
  workDir?: string;
  isFirstMessage: boolean;
  todoItems: RollbackTodoItem[];
  /** 被回滚轮次保存的项目记忆清单；非空时展示可选清理项。 */
  memoryItems: RollbackMemoryItem[];
  /** 被回滚轮次关联的 WorkFlow 数量：>0 时提示将级联中止并删除。 */
  workflowFlowCount: number;
  /** 持久化截断失败时的错误信息，显示在对话框顶部提醒用户重试。 */
  error?: string;
  onConfirm: (
    mode: RollbackMode,
    deleteMemories: boolean,
  ) => void | Promise<void>;
  onCancel: () => void;
};

const MAX_VISIBLE_FILES = 50;

const CHANGE_LABEL_KEY = {
  added: "chat.rollbackChangeAdded",
  modified: "chat.rollbackChangeModified",
  deleted: "chat.rollbackChangeDeleted",
} as const;

export const RollbackConfirmDialog = ({
  changes,
  checkpointIds,
  workDir,
  isFirstMessage,
  todoItems,
  memoryItems,
  workflowFlowCount,
  error,
  onConfirm,
  onCancel,
}: RollbackConfirmDialogProps): React.JSX.Element | null => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [diffs, setDiffs] = useState<CheckpointFileDiff[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [isTodoExpanded, setIsTodoExpanded] = useState(false);
  /** 记忆清理选项：默认不勾选（保留记忆，与删除会话弹窗语义一致）。 */
  const [deleteMemories, setDeleteMemories] = useState(false);
  const [isMemoryExpanded, setIsMemoryExpanded] = useState(false);
  /** 确认进行中的模式：文件恢复（SSH 下经 SFTP）可能较慢，期间禁用
   *  对话框交互并在确认按钮上显示 loading。 */
  const [confirmingMode, setConfirmingMode] = useState<RollbackMode | null>(
    null,
  );
  /** 防重入标志：confirmingMode 是异步 setState，同帧内双击/Enter+点击
   *  连点会穿透 state 检查并发执行两次 confirmRollback，第二次在第一次
   *  完成后的重复截断/删除会失败并弹回错误弹窗（表现为回滚异常）。 */
  const confirmingRef = useRef(false);

  // ESC 层级栈：预览展开时先收起预览，再按一次才取消对话框（先子后父）；
  // 确认进行中（confirmingMode）期间拒绝响应——gate=false 时 ESC 无动作，
  // 也不会误关被遮挡的下层浮层或触发全局 cancelSession。
  useEscapeKey({
    onEscape: () => {
      if (isPreviewOpen) {
        setIsPreviewOpen(false);
      } else {
        onCancel();
      }
    },
    gate: () => confirmingMode === null,
  });

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleConfirm = async (mode: RollbackMode): Promise<void> => {
    // ref 防重入：state 更新是异步的，同帧连点会穿透 confirmingMode 检查。
    if (confirmingRef.current || confirmingMode) {
      return;
    }
    confirmingRef.current = true;
    setConfirmingMode(mode);
    try {
      await onConfirm(mode, deleteMemories);
    } finally {
      confirmingRef.current = false;
      setConfirmingMode(null);
    }
  };

  const grouped = useMemo(() => {
    const added = changes.filter((c) => c.changeType === "added");
    const modified = changes.filter((c) => c.changeType === "modified");
    const deleted = changes.filter((c) => c.changeType === "deleted");
    return { added, modified, deleted };
  }, [changes]);

  const visibleChanges = useMemo(
    () => changes.slice(0, MAX_VISIBLE_FILES),
    [changes],
  );
  const hiddenCount = changes.length - visibleChanges.length;

  const openPreview = (): void => {
    if (checkpointIds.length === 0 || !workDir) {
      return;
    }
    setIsPreviewOpen(true);
    if (diffs.length > 0 || previewLoading) {
      return;
    }
    setPreviewLoading(true);
    setPreviewError(false);
    void window.snow
      // includeAll=false：diff 预览与实际回滚范围一致（只显示仍处于
      // checkpoint 后状态、确认回滚时会被恢复的文件）。
      .listCheckpointDiffsBatch(checkpointIds, workDir, false)
      .then((result) => {
        setDiffs(result);
      })
      .catch(() => {
        setPreviewError(true);
      })
      .finally(() => {
        setPreviewLoading(false);
      });
  };

  return createPortal(
    <div
      className="confirm-dialog-overlay"
      onKeyDown={(e) => {
        // ESC 关闭（预览先收起，否则取消对话框）统一由 useEscapeKey
        // 层级栈处理；这里仅保留 Enter 确认（确认进行中不响应）。
        if (confirmingMode) {
          return;
        }
        if (e.key === "Enter" && e.target === dialogRef.current) {
          e.preventDefault();
          void handleConfirm("conversation-and-files");
        }
      }}
    >
      <div
        className={`confirm-dialog rollback-confirm-dialog ${
          isPreviewOpen ? "preview-open" : ""
        }`}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="confirm-dialog-header">
          <div className="confirm-dialog-title">
            {isPreviewOpen ? (
              <button
                type="button"
                className="rollback-preview-back"
                onClick={() => setIsPreviewOpen(false)}
                aria-label={t("chat.rollbackBackToSummary")}
                title={t("chat.rollbackBackToSummary")}
              >
                <ArrowLeft size={15} />
              </button>
            ) : (
              <AlertTriangle size={16} />
            )}
            <span>
              {isPreviewOpen
                ? t("chat.rollbackPreviewTitle")
                : t("chat.rollbackConfirmTitle")}
            </span>
          </div>
        </div>
        {isPreviewOpen ? (
          <FileDiffPreview
            diffs={diffs}
            isLoading={previewLoading}
            hasError={previewError}
            labels={{
              loading: t("chat.rollbackPreviewLoading"),
              error: t("chat.rollbackPreviewError"),
              empty: t("chat.rollbackPreviewEmpty"),
              selectFile: t("chat.rollbackPreviewSelectFile"),
            }}
          />
        ) : (
          <div className="confirm-dialog-body">
            {error && (
              <div className="rollback-error-notice" role="alert">
                <AlertTriangle size={14} />
                <span>{error}</span>
              </div>
            )}
            {isFirstMessage && <p>{t("chat.rollbackFirstMessageNotice")}</p>}
            {changes.length > 0 ? (
              <>
                <p>
                  {t("chat.rollbackChangesNotice", {
                    values: { count: changes.length },
                  })}
                </p>
                <div className="rollback-change-summary">
                  {grouped.added.length > 0 && (
                    <span className={getFileChangeClassName("added")}>
                      {t("chat.rollbackChangeAdded")} {grouped.added.length}
                    </span>
                  )}
                  {grouped.modified.length > 0 && (
                    <span className={getFileChangeClassName("modified")}>
                      {t("chat.rollbackChangeModified")}{" "}
                      {grouped.modified.length}
                    </span>
                  )}
                  {grouped.deleted.length > 0 && (
                    <span className={getFileChangeClassName("deleted")}>
                      {t("chat.rollbackChangeDeleted")} {grouped.deleted.length}
                    </span>
                  )}
                </div>
                <ul className="rollback-change-list">
                  {visibleChanges.map((change) => {
                    return (
                      <li key={change.path} className="rollback-change-item">
                        <FileChangeIcon changeType={change.changeType} />
                        <span className="rollback-change-type">
                          {t(
                            CHANGE_LABEL_KEY[
                              change.changeType as keyof typeof CHANGE_LABEL_KEY
                            ] ?? change.changeType,
                          )}
                        </span>
                        <span
                          className="rollback-change-path"
                          title={change.path}
                        >
                          {getFileTypeIcon(
                            getFileName(change.path),
                            false,
                            false,
                            {
                              size: 13,
                              "aria-hidden": true,
                            },
                          )}
                          <span className="rollback-change-path-text">
                            {change.path}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {hiddenCount > 0 && (
                  <p className="rollback-change-more">
                    {t("chat.rollbackHiddenChanges", {
                      values: { count: hiddenCount },
                    })}
                  </p>
                )}
              </>
            ) : (
              <p>{t("chat.rollbackNoChangesNotice")}</p>
            )}
            {workflowFlowCount > 0 && (
              <div className="rollback-workflow-notice">
                <Workflow size={14} />
                <span>
                  {t("chat.rollbackWorkflowNotice", {
                    values: { count: workflowFlowCount },
                  })}
                </span>
              </div>
            )}
            {todoItems.length > 0 && (
              <div className="rollback-todo-notice">
                <button
                  type="button"
                  className="rollback-todo-toggle"
                  onClick={() => setIsTodoExpanded((v) => !v)}
                  aria-label={t("chat.rollbackTodoToggle")}
                  title={t("chat.rollbackTodoToggle")}
                >
                  {isTodoExpanded ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                </button>
                <ListChecks size={14} />
                <span>
                  {t("chat.rollbackTodoNotice", {
                    values: { count: todoItems.length },
                  })}
                </span>
              </div>
            )}
            {isTodoExpanded && todoItems.length > 0 && (
              <ul className="rollback-todo-list">
                {todoItems.map((todo) => (
                  <li key={todo.id} className="rollback-todo-item">
                    <CheckSquare
                      size={12}
                      className="rollback-todo-item-icon"
                    />
                    <span className="rollback-todo-item-content">
                      {todo.content}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {memoryItems.length > 0 && (
              <>
                <div className="rollback-todo-notice rollback-memory-notice">
                  <button
                    type="button"
                    className="rollback-todo-toggle"
                    onClick={() => setIsMemoryExpanded((v) => !v)}
                    aria-label={t("chat.rollbackMemoryToggle")}
                    title={t("chat.rollbackMemoryToggle")}
                  >
                    {isMemoryExpanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </button>
                  <Brain size={14} />
                  <label className="rollback-memory-option">
                    <input
                      checked={deleteMemories}
                      disabled={confirmingMode !== null}
                      onChange={(event) =>
                        setDeleteMemories(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>
                      {t("chat.rollbackMemoryOption", {
                        values: { count: memoryItems.length },
                      })}
                    </span>
                  </label>
                </div>
                {isMemoryExpanded && (
                  <ul className="rollback-todo-list">
                    {memoryItems.map((memory) => (
                      <li key={memory.memoryId} className="rollback-todo-item">
                        <Brain size={12} className="rollback-todo-item-icon" />
                        <span className="rollback-todo-item-content">
                          {memory.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
        <div className="confirm-dialog-actions">
          {!isPreviewOpen &&
            changes.length > 0 &&
            checkpointIds.length > 0 &&
            workDir && (
              <button
                type="button"
                className="confirm-dialog-btn preview"
                disabled={confirmingMode !== null}
                onClick={openPreview}
              >
                <Eye size={14} />
                {t("chat.rollbackViewChanges")}
              </button>
            )}
          <div className="rollback-dialog-primary-actions">
            <button
              type="button"
              className="confirm-dialog-btn cancel"
              disabled={confirmingMode !== null}
              onClick={onCancel}
            >
              {t("common.cancel")}
            </button>
            {changes.length > 0 && (
              <button
                type="button"
                className="confirm-dialog-btn conversation-only"
                disabled={confirmingMode !== null}
                onClick={() => void handleConfirm("conversation-only")}
              >
                {confirmingMode === "conversation-only" && (
                  <Loader2 size={15} className="spin" />
                )}
                {confirmingMode !== "conversation-only" && <FileX2 size={14} />}
                {confirmingMode === "conversation-only"
                  ? t("chat.rollbackInProgress")
                  : t("chat.rollbackConversationOnlyAction")}
              </button>
            )}
            <button
              type="button"
              className="confirm-dialog-btn confirm"
              disabled={confirmingMode !== null}
              onClick={() => void handleConfirm("conversation-and-files")}
            >
              {confirmingMode === "conversation-and-files" && (
                <Loader2 size={15} className="spin" />
              )}
              {confirmingMode === "conversation-and-files"
                ? t("chat.rollbackInProgress")
                : changes.length > 0
                  ? t("chat.rollbackConversationAndFilesAction")
                  : t("chat.rollbackConfirmAction")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
