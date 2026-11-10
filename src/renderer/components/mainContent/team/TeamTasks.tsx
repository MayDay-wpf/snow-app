import {
  Bot,
  CheckCircle2,
  CircleDot,
  Flag,
  GitPullRequest,
  Loader2,
  Plus,
  Trash2,
  UserCheck,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { TeamReview, TeamTask } from "../../../../preload";
import { useI18n } from "../../../i18n";
import {
  CustomSelect,
  type CustomSelectOption,
} from "../../common/CustomSelect";
import { Modal } from "../../common/Modal";
import { useChatConversationContext } from "../chatMessages";
import type { TeamData } from "./useTeamData";
import { TeamEmpty, TeamErrorNotice, TeamMemberChip } from "./TeamShared";
import {
  formatTime,
  memberName,
  newId,
  nowIso,
  TASK_STATUSES,
} from "./teamUtils";

const STATUS_LABEL_KEY: Record<string, string> = {
  todo: "team.tasks.status.todo",
  in_progress: "team.tasks.status.in_progress",
  review: "team.tasks.status.review",
  done: "team.tasks.status.done",
};

const PRIORITY_LABEL_KEY: Record<string, string> = {
  low: "team.tasks.priority.low",
  medium: "team.tasks.priority.medium",
  high: "team.tasks.priority.high",
};

const PRIORITY_VALUES = ["low", "medium", "high"] as const;

type TaskDraft = {
  title: string;
  description: string;
  assigneePeerId: string;
  priority: string;
  labels: string;
  linkedFiles: string;
};

const EMPTY_DRAFT: TaskDraft = {
  title: "",
  description: "",
  assigneePeerId: "",
  priority: "medium",
  labels: "",
  linkedFiles: "",
};

const splitList = (value: string): string[] =>
  value
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

export const TeamTasks = ({
  team,
  directoryId,
  onNavigateToView,
}: {
  team: TeamData;
  directoryId: string;
  onNavigateToView: (view: import("../types").MainContentView) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  /** 状态 / 优先级标签：映射表存 i18n key，渲染时再取当前语言文案。 */
  const statusLabel = (value: string): string => {
    const key = STATUS_LABEL_KEY[value];
    return key ? t(key) : value;
  };
  const priorityLabel = (value: string): string => {
    const key = PRIORITY_LABEL_KEY[value];
    return key ? t(key) : value;
  };
  const priorityOptions: CustomSelectOption[] = PRIORITY_VALUES.map(
    (value) => ({
      value,
      label: priorityLabel(value),
    }),
  );
  const { handleNewChat, handleSendMessage } = useChatConversationContext();
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<TeamTask | null>(null);
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);

  const myPeerId = team.me.peerId;

  /** 指派对象下拉项：团队成员按 peer id 取值，缺失时补上本机身份。 */
  const memberOptions: CustomSelectOption[] = useMemo(() => {
    const options = team.members.map((member) => ({
      value: member.peerId,
      label: member.name || member.peerId,
    }));
    if (myPeerId && !options.some((option) => option.value === myPeerId)) {
      options.push({ value: myPeerId, label: team.me.name || myPeerId });
    }
    return options;
  }, [team.members, team.me.name, myPeerId]);

  const grouped = useMemo(() => {
    const groups: Record<string, TeamTask[]> = {
      todo: [],
      in_progress: [],
      review: [],
      done: [],
    };
    for (const task of team.tasks) {
      (groups[task.status] ?? groups.todo).push(task);
    }
    return groups;
  }, [team.tasks]);

  const openCreate = (): void => {
    setDraft({ ...EMPTY_DRAFT, assigneePeerId: myPeerId });
    setError(null);
    setCreating(true);
  };

  const handleCreate = async (): Promise<void> => {
    if (!draft.title.trim()) {
      setError(t("team.tasks.errorTitle", { defaultValue: "请输入任务标题" }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const now = nowIso();
      const record: TeamTask = {
        id: newId("task"),
        title: draft.title.trim(),
        description: draft.description.trim(),
        creatorPeerId: myPeerId,
        assigneePeerId: draft.assigneePeerId || myPeerId,
        status: "todo",
        priority: draft.priority as TeamTask["priority"],
        labels: splitList(draft.labels),
        linkedFiles: splitList(draft.linkedFiles),
        createdAt: now,
        updatedAt: now,
        history: [
          {
            at: now,
            by: myPeerId,
            action: "created",
            detail: draft.title.trim(),
          },
        ],
      };
      await team.publish("task", record.id, record);
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateTask = async (
    task: TeamTask,
    patch: Partial<TeamTask>,
    historyAction: string,
    historyDetail: string,
  ): Promise<void> => {
    const now = nowIso();
    const updated: TeamTask = {
      ...task,
      ...patch,
      updatedAt: now,
      history: [
        ...task.history,
        { at: now, by: myPeerId, action: historyAction, detail: historyDetail },
      ],
    };
    await team.publish("task", task.id, updated);
    setDetail(updated);
  };

  const takeTask = async (task: TeamTask): Promise<void> => {
    if (task.assigneePeerId === myPeerId && task.status !== "todo") {
      return;
    }
    const now = nowIso();
    const history = [...task.history];
    if (task.assigneePeerId !== myPeerId) {
      history.push({
        at: now,
        by: myPeerId,
        action: "assigned",
        detail: myPeerId,
      });
    }
    if (task.status === "todo") {
      history.push({
        at: now,
        by: myPeerId,
        action: "status",
        detail: "in_progress",
      });
    }
    const updated: TeamTask = {
      ...task,
      assigneePeerId: myPeerId,
      status: task.status === "todo" ? "in_progress" : task.status,
      updatedAt: now,
      history,
    };
    await team.publish("task", task.id, updated);
    setDetail(updated);
  };

  const setStatus = async (
    task: TeamTask,
    status: TeamTask["status"],
  ): Promise<void> => {
    await updateTask(task, { status }, "status", status);
  };

  /** 交给当前 AI 会话执行：切到聊天视图，新会话并自动发送任务上下文。 */
  const aiTakeTask = async (task: TeamTask): Promise<void> => {
    setBusy(true);
    try {
      if (task.assigneePeerId !== myPeerId || task.status !== "in_progress") {
        const now = nowIso();
        const updated: TeamTask = {
          ...task,
          assigneePeerId: myPeerId,
          status: "in_progress",
          updatedAt: now,
          history: [
            ...task.history,
            { at: now, by: myPeerId, action: "assigned", detail: myPeerId },
            {
              at: now,
              by: myPeerId,
              action: "status",
              detail: "in_progress",
            },
            {
              at: now,
              by: myPeerId,
              action: "ai_started",
              detail: t("team.tasks.activityAiStarted"),
            },
          ],
        };
        await team.publish("task", task.id, updated);
      }
      setDetail(null);
      const files =
        task.linkedFiles.length > 0
          ? `\n关联文件：${task.linkedFiles.join("、")}`
          : "";
      const prompt = `请协助我完成团队任务「${task.title}」。\n\n任务描述：\n${task.description || "（无）"}${files}\n\n要求：\n1. 完成后通过 git 提交变更；\n2. 整理改动说明，并在团队中发起代码评审。`;
      onNavigateToView("chat");
      handleNewChat(directoryId);
      window.setTimeout(() => {
        handleSendMessage(prompt, {});
      }, 400);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteTask = async (task: TeamTask): Promise<void> => {
    setDeleting(true);
    try {
      await team.remove("task", task.id);
      setDetail(null);
    } catch {
      // 删除失败静默
    } finally {
      setDeleting(false);
    }
  };

  /** 为任务直接创建一条待评审记录（评审页签中可见）。 */
  const requestReview = async (task: TeamTask): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const now = nowIso();
      const record: TeamReview = {
        id: newId("review"),
        title: t("team.reviews.defaultTitle", {
          values: { title: task.title },
        }),
        taskId: task.id,
        creatorPeerId: myPeerId,
        // 指派给他人的任务由对方评审，否则由本人自审
        reviewerPeerId:
          task.assigneePeerId && task.assigneePeerId !== myPeerId
            ? task.assigneePeerId
            : myPeerId,
        status: "pending",
        summary: task.description,
        createdAt: now,
        updatedAt: now,
        history: [
          { at: now, by: myPeerId, action: "created", detail: task.title },
        ],
        comments: [],
      };
      await team.publish("review", record.id, record);
      setDetail(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const renderTaskCard = (task: TeamTask): React.JSX.Element => (
    <button
      type="button"
      key={task.id}
      className="team-task-card"
      onClick={() => setDetail(task)}
    >
      <div className="team-task-card-top">
        <span
          className={`team-priority is-${task.priority}`}
          title={t("team.priorityTooltip", {
            values: { priority: priorityLabel(task.priority) },
          })}
        >
          <Flag size={12} />
        </span>
        <span className="team-task-card-title">{task.title}</span>
        <span className={`team-status is-${task.status}`}>
          {statusLabel(task.status)}
        </span>
      </div>
      {task.description ? (
        <div className="team-task-card-desc">{task.description}</div>
      ) : null}
      <div className="team-task-card-bottom">
        <TeamMemberChip members={team.members} peerId={task.assigneePeerId} />
        {task.labels.length > 0 ? (
          <span className="team-task-labels">
            {task.labels.map((label) => (
              <span key={label} className="team-label">
                {label}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </button>
  );

  return (
    <div className="team-tasks">
      <div className="team-tab-toolbar">
        <span className="team-tab-title">
          {t("team.tasks.title", { defaultValue: "任务" })}
        </span>
        <button
          type="button"
          className="team-btn team-btn-primary"
          onClick={openCreate}
        >
          <Plus size={15} />
          {t("team.tasks.new", { defaultValue: "新建任务" })}
        </button>
      </div>

      {team.tasks.length === 0 ? (
        <TeamEmpty
          icon={<CircleDot size={28} strokeWidth={1.4} />}
          text={t("team.tasks.empty", {
            defaultValue:
              "还没有任务。创建一个任务，指派给队友，让 AI 接力执行。",
          })}
        />
      ) : (
        <div className="team-task-groups">
          {TASK_STATUSES.map((status) => {
            const items = grouped[status] ?? [];
            if (items.length === 0) {
              return null;
            }
            return (
              <div key={status} className="team-task-group">
                <div className="team-task-group-title">
                  <span className={`team-status-dot is-${status}`} />
                  {statusLabel(status)}
                  <span className="team-task-group-count">{items.length}</span>
                </div>
                <div className="team-task-group-list">
                  {items.map(renderTaskCard)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={creating}
        title={t("team.tasks.new", { defaultValue: "新建任务" })}
        closeLabel={t("common.close", { defaultValue: "关闭" })}
        onClose={() => setCreating(false)}
        footer={
          <>
            <button
              type="button"
              className="team-btn team-btn-primary"
              disabled={busy}
              onClick={() => void handleCreate()}
            >
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Plus size={15} />
              )}
              {t("team.tasks.create", { defaultValue: "创建" })}
            </button>
          </>
        }
      >
        <div className="team-form">
          <label className="team-form-label">
            {t("team.tasks.titleField", { defaultValue: "标题" })}
            <input
              className="team-form-input"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              autoFocus
            />
          </label>
          <label className="team-form-label">
            {t("team.tasks.descField", { defaultValue: "描述" })}
            <textarea
              className="team-form-input team-form-textarea"
              rows={4}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </label>
          <div className="team-form-row">
            <label className="team-form-label">
              {t("team.tasks.assignee", { defaultValue: "指派给" })}
              <CustomSelect
                value={draft.assigneePeerId}
                options={memberOptions}
                onChange={(v) => setDraft({ ...draft, assigneePeerId: v })}
                portal
              />
            </label>
            <label className="team-form-label">
              {t("team.tasks.priority", { defaultValue: "优先级" })}
              <CustomSelect
                value={draft.priority}
                options={priorityOptions}
                onChange={(v) => setDraft({ ...draft, priority: v })}
                portal
              />
            </label>
          </div>
          <label className="team-form-label">
            {t("team.tasks.labels", { defaultValue: "标签（逗号分隔）" })}
            <input
              className="team-form-input"
              value={draft.labels}
              onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
            />
          </label>
          <label className="team-form-label">
            {t("team.tasks.files", { defaultValue: "关联文件（逗号分隔）" })}
            <input
              className="team-form-input"
              value={draft.linkedFiles}
              onChange={(e) =>
                setDraft({ ...draft, linkedFiles: e.target.value })
              }
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={detail !== null}
        title={detail?.title ?? ""}
        closeLabel={t("common.close", { defaultValue: "关闭" })}
        onClose={() => setDetail(null)}
        size="large"
        footer={
          detail ? (
            <div className="team-detail-actions">
              <button
                type="button"
                className="team-btn"
                disabled={busy || deleting}
                onClick={() => void takeTask(detail)}
                title={t("team.tasks.assignMe", { defaultValue: "认领此任务" })}
              >
                <UserCheck size={15} />
                {t("team.tasks.assignMe", { defaultValue: "认领" })}
              </button>
              <button
                type="button"
                className="team-btn team-btn-primary"
                disabled={busy || deleting}
                onClick={() => void aiTakeTask(detail)}
                title={t("team.tasks.aiExecute", {
                  defaultValue: "交给当前 AI 会话执行",
                })}
              >
                <Bot size={15} />
                {t("team.tasks.aiExecute", { defaultValue: "交给 AI 执行" })}
              </button>
              <button
                type="button"
                className="team-btn team-btn-accent"
                disabled={busy || deleting}
                onClick={() => void requestReview(detail)}
                title={t("team.tasks.requestReview", {
                  defaultValue: "为当前改动发起代码评审",
                })}
              >
                <GitPullRequest size={15} />
                {t("team.tasks.requestReview", { defaultValue: "发起评审" })}
              </button>
              <button
                type="button"
                className="team-btn team-btn-danger"
                disabled={busy || deleting}
                onClick={() => void deleteTask(detail)}
                title={t("team.tasks.delete", { defaultValue: "删除任务" })}
              >
                {deleting ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Trash2 size={15} />
                )}
              </button>
            </div>
          ) : null
        }
      >
        {detail ? (
          <div className="team-detail">
            <div className="team-detail-meta">
              <TeamMemberChip
                members={team.members}
                peerId={detail.assigneePeerId}
                currentPeerId={myPeerId}
              />
              <span className="team-detail-meta-item">
                <Flag size={12} />
                {priorityLabel(detail.priority)}
              </span>
              <span className="team-detail-meta-item">
                {formatTime(detail.updatedAt)}
              </span>
            </div>
            <div className="team-status-stepper">
              {TASK_STATUSES.map((status, index) => {
                const currentIndex = TASK_STATUSES.indexOf(
                  detail.status as (typeof TASK_STATUSES)[number],
                );
                const active = detail.status === status;
                const done = currentIndex > index;
                return (
                  <button
                    type="button"
                    key={status}
                    className={`team-status-step is-${status}${
                      active ? " is-active" : ""
                    }${done ? " is-done" : ""}`}
                    disabled={busy || deleting}
                    onClick={() => void setStatus(detail, status)}
                    title={t("team.tasks.setStatus", {
                      defaultValue: "切换状态",
                    })}
                  >
                    {done || active ? (
                      <CheckCircle2 size={13} />
                    ) : (
                      <CircleDot size={13} />
                    )}
                    {statusLabel(status)}
                  </button>
                );
              })}
            </div>
            {detail.description ? (
              <div className="team-detail-section">
                <div className="team-detail-section-title">
                  {t("team.tasks.descField", { defaultValue: "描述" })}
                </div>
                <div className="team-detail-text">{detail.description}</div>
              </div>
            ) : null}
            {detail.linkedFiles.length > 0 ? (
              <div className="team-detail-section">
                <div className="team-detail-section-title">
                  {t("team.tasks.files", { defaultValue: "关联文件" })}
                </div>
                <div className="team-detail-files">
                  {detail.linkedFiles.map((file) => (
                    <code key={file}>{file}</code>
                  ))}
                </div>
              </div>
            ) : null}
            {detail.history.length > 0 ? (
              <div className="team-detail-section">
                <div className="team-detail-section-title">
                  {t("team.tasks.history", { defaultValue: "动态" })}
                </div>
                <div className="team-detail-history">
                  {detail.history.map((h, i) => (
                    <div key={i} className="team-detail-history-item">
                      <span className="team-detail-history-author">
                        {memberName(team.members, h.by)}
                      </span>
                      <span className="team-detail-history-action">
                        {h.action}
                      </span>
                      <span className="team-detail-history-detail">
                        {h.detail}
                      </span>
                      <span className="team-detail-history-time">
                        {formatTime(h.at)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
      <TeamErrorNotice message={error} onDismiss={clearError} />
    </div>
  );
};
