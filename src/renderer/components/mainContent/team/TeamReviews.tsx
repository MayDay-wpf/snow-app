import {
  CheckCircle2,
  GitPullRequest,
  Loader2,
  MessageSquarePlus,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TeamMember, TeamReview } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";
import { Modal } from "../../common/Modal";
import type { TeamData } from "./useTeamData";
import { TeamEmpty, TeamMemberChip } from "./TeamShared";
import {
  formatTime,
  memberName,
  newId,
  nowIso,
  REVIEW_STATUSES,
} from "./teamUtils";

const STATUS_LABEL: Record<string, string> = {
  pending: "待评审",
  approved: "已批准",
  rejected: "已驳回",
  merged: "已合并",
};

const REVIEW_FLOW = ["pending", "approved", "rejected", "merged"] as const;

type ReviewDraft = {
  title: string;
  taskId: string;
  branch: string;
  baseBranch: string;
  reviewerEmail: string;
  summary: string;
};

const EMPTY_DRAFT: ReviewDraft = {
  title: "",
  taskId: "",
  branch: "",
  baseBranch: "main",
  reviewerEmail: "",
  summary: "",
};

export const TeamReviews = ({
  team,
  presetTask,
  onPresetTaskConsumed,
}: {
  team: TeamData;
  presetTask: import("../../../../preload").TeamTask | null;
  onPresetTaskConsumed: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<TeamReview | null>(null);
  const [draft, setDraft] = useState<ReviewDraft>(EMPTY_DRAFT);
  const [commentDraft, setCommentDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const myEmail = team.identity?.email ?? "";

  // 从任务详情「发起评审」进入时，自动打开创建表单并预填
  useEffect(() => {
    if (presetTask) {
      setDraft({
        ...EMPTY_DRAFT,
        title: `评审：${presetTask.title}`,
        taskId: presetTask.id,
        reviewerEmail: myEmail,
      });
      setError(null);
      setCreating(true);
      onPresetTaskConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetTask]);

  const openCreate = (
    preset?: import("../../../../preload").TeamTask | null,
  ): void => {
    setDraft({
      ...EMPTY_DRAFT,
      title: preset ? `评审：${preset.title}` : "",
      taskId: preset?.id ?? "",
      reviewerEmail: myEmail,
      branch:
        preset?.labels.find((l) => l.startsWith("branch:"))?.slice(7) ?? "",
    });
    setError(null);
    setCreating(true);
    onPresetTaskConsumed();
  };

  const handleCreate = async (): Promise<void> => {
    if (!draft.title.trim() || !draft.branch.trim()) {
      setError(
        t("team.reviews.errorRequired", {
          defaultValue: "请填写标题与分支名",
        }),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const now = nowIso();
      const record: TeamReview = {
        id: newId("review"),
        title: draft.title.trim(),
        taskId: draft.taskId || null,
        branch: draft.branch.trim(),
        baseBranch: draft.baseBranch.trim() || "main",
        creatorEmail: myEmail,
        reviewerEmail: draft.reviewerEmail || myEmail,
        status: "pending",
        summary: draft.summary.trim(),
        createdAt: now,
        updatedAt: now,
        history: [
          {
            at: now,
            by: myEmail,
            action: "created",
            detail: draft.title.trim(),
          },
        ],
        comments: [],
      };
      await team.publish("review", record.id, record);
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateReview = async (
    review: TeamReview,
    patch: Partial<TeamReview>,
    historyAction: string,
    historyDetail: string,
  ): Promise<void> => {
    const now = nowIso();
    const updated: TeamReview = {
      ...review,
      ...patch,
      updatedAt: now,
      history: [
        ...review.history,
        { at: now, by: myEmail, action: historyAction, detail: historyDetail },
      ],
    };
    await team.publish("review", review.id, updated);
    setDetail(updated);
  };

  const addComment = async (review: TeamReview): Promise<void> => {
    const content = commentDraft.trim();
    if (!content || busy) {
      return;
    }
    setBusy(true);
    try {
      const now = nowIso();
      const updated: TeamReview = {
        ...review,
        updatedAt: now,
        comments: [
          ...review.comments,
          {
            id: newId("cmt"),
            authorEmail: myEmail,
            content,
            createdAt: now,
          },
        ],
        history: [
          ...review.history,
          { at: now, by: myEmail, action: "comment", detail: content },
        ],
      };
      await team.publish("review", review.id, updated);
      setCommentDraft("");
    } finally {
      setBusy(false);
    }
  };

  const deleteComment = async (
    review: TeamReview,
    commentId: string,
  ): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const now = nowIso();
      const updated: TeamReview = {
        ...review,
        updatedAt: now,
        comments: review.comments.filter((c) => c.id !== commentId),
      };
      await team.publish("review", review.id, updated);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (
    review: TeamReview,
    status: TeamReview["status"],
  ): Promise<void> => {
    await updateReview(review, { status }, "status", status);
  };

  const deleteReview = async (review: TeamReview): Promise<void> => {
    await team.remove("review", review.id);
    setDetail(null);
  };

  const { pending, mine, history } = useMemo(() => {
    const pendingList: TeamReview[] = [];
    const mineList: TeamReview[] = [];
    const historyList: TeamReview[] = [];
    for (const review of team.reviews) {
      if (review.status === "pending") {
        pendingList.push(review);
      } else if (review.creatorEmail === myEmail) {
        historyList.push(review);
      } else {
        historyList.push(review);
      }
      if (review.creatorEmail === myEmail && review.status === "pending") {
        mineList.push(review);
      }
    }
    const sortByTime = (a: TeamReview, b: TeamReview) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    pendingList.sort(sortByTime);
    mineList.sort(sortByTime);
    historyList.sort(sortByTime);
    return { pending: pendingList, mine: mineList, history: historyList };
  }, [team.reviews, myEmail]);

  const selectOptions = (): (
    TeamMember | { email: string; name: string }
  )[] => {
    const members: { email: string; name: string }[] = team.members.map(
      (m) => ({ email: m.email, name: m.name }),
    );
    const emails = new Set(members.map((m) => m.email));
    if (!emails.has(myEmail)) {
      members.push({ email: myEmail, name: myEmail.split("@")[0] ?? myEmail });
    }
    return members;
  };

  const renderCard = (review: TeamReview): React.JSX.Element => (
    <button
      type="button"
      key={review.id}
      className="team-review-card"
      onClick={() => setDetail(review)}
    >
      <div className="team-task-card-top">
        <span className="team-review-icon">
          <GitPullRequest size={14} />
        </span>
        <span className="team-task-card-title">{review.title}</span>
        <span className={`team-status is-${review.status}`}>
          {STATUS_LABEL[review.status] ?? review.status}
        </span>
      </div>
      <div className="team-review-meta">
        <code className="team-branch-tag">{review.branch}</code>
        <span className="team-review-arrow">←</span>
        <code className="team-branch-tag">{review.baseBranch}</code>
      </div>
      {review.summary ? (
        <div className="team-task-card-desc">{review.summary}</div>
      ) : null}
      <div className="team-task-card-bottom">
        <TeamMemberChip
          members={team.members}
          email={review.reviewerEmail}
          currentEmail={myEmail}
        />
        <span className="team-comment-count">
          {review.comments.length} 条评论
        </span>
      </div>
    </button>
  );

  const renderGroup = (
    key: string,
    title: string,
    items: TeamReview[],
  ): React.JSX.Element | null => {
    if (items.length === 0) {
      return null;
    }
    return (
      <div key={key} className="team-task-group">
        <div className="team-task-group-title">
          <span className="team-status-dot is-muted" />
          {title}
          <span className="team-task-group-count">{items.length}</span>
        </div>
        <div className="team-task-group-list">{items.map(renderCard)}</div>
      </div>
    );
  };

  return (
    <div className="team-tasks">
      <div className="team-tab-toolbar">
        <span className="team-tab-title">
          {t("team.reviews.title", { defaultValue: "代码评审" })}
        </span>
        <button
          type="button"
          className="team-btn team-btn-primary"
          onClick={() => openCreate(null)}
        >
          <Plus size={15} />
          {t("team.reviews.new", { defaultValue: "发起评审" })}
        </button>
      </div>

      {team.reviews.length === 0 ? (
        <TeamEmpty
          icon={<GitPullRequest size={28} strokeWidth={1.4} />}
          text={t("team.reviews.empty", {
            defaultValue:
              "还没有代码评审。AI 完成改动后，把分支发布成评审请求让队友把关。",
          })}
        />
      ) : (
        <div className="team-task-groups">
          {renderGroup(
            "pending",
            t("team.reviews.groupPending", { defaultValue: "待我评审" }),
            pending,
          )}
          {renderGroup(
            "mine",
            t("team.reviews.groupMine", { defaultValue: "我发起的" }),
            mine,
          )}
          {renderGroup(
            "history",
            t("team.reviews.groupHistory", { defaultValue: "历史" }),
            history,
          )}
        </div>
      )}

      <Modal
        open={creating}
        title={t("team.reviews.new", { defaultValue: "发起代码评审" })}
        closeLabel={t("common.close", { defaultValue: "关闭" })}
        onClose={() => setCreating(false)}
        size="large"
        footer={
          <>
            {error ? <span className="team-form-error">{error}</span> : null}
            <button
              type="button"
              className="team-btn team-btn-primary"
              disabled={busy}
              onClick={() => void handleCreate()}
            >
              {busy ? <Loader2 size={15} className="spin" /> : null}
              {t("team.reviews.create", { defaultValue: "发布评审" })}
            </button>
          </>
        }
      >
        <div className="team-form">
          <label className="team-form-label">
            {t("team.reviews.titleField", { defaultValue: "标题" })}
            <input
              className="team-form-input"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              autoFocus
            />
          </label>
          <div className="team-form-row">
            <label className="team-form-label">
              {t("team.reviews.branch", { defaultValue: "待评审分支" })}
              <input
                className="team-form-input"
                value={draft.branch}
                placeholder="feature/xxx"
                onChange={(e) => setDraft({ ...draft, branch: e.target.value })}
              />
            </label>
            <label className="team-form-label">
              {t("team.reviews.baseBranch", { defaultValue: "基础分支" })}
              <input
                className="team-form-input"
                value={draft.baseBranch}
                onChange={(e) =>
                  setDraft({ ...draft, baseBranch: e.target.value })
                }
              />
            </label>
          </div>
          {team.tasks.length > 0 ? (
            <label className="team-form-label">
              {t("team.reviews.task", { defaultValue: "关联任务" })}
              <CustomSelect
                value={draft.taskId}
                options={[
                  {
                    value: "",
                    label: t("team.reviews.noTask", {
                      defaultValue: "（不关联任务）",
                    }),
                  },
                  ...team.tasks.map((task) => ({
                    value: task.id,
                    label: task.title,
                  })),
                ]}
                onChange={(v) => setDraft({ ...draft, taskId: v })}
                filterable
                portal
              />
            </label>
          ) : null}
          <label className="team-form-label">
            {t("team.reviews.reviewer", { defaultValue: "评审人" })}
            <CustomSelect
              value={draft.reviewerEmail}
              options={selectOptions().map((m) => ({
                value: m.email,
                label: `${m.name} <${m.email}>`,
              }))}
              onChange={(v) => setDraft({ ...draft, reviewerEmail: v })}
              portal
            />
          </label>
          <label className="team-form-label">
            {t("team.reviews.summary", { defaultValue: "变更说明" })}
            <textarea
              className="team-form-input team-form-textarea"
              rows={4}
              value={draft.summary}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
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
              {error ? <span className="team-form-error">{error}</span> : null}
              <button
                type="button"
                className="team-btn team-btn-success"
                disabled={busy}
                onClick={() => void setStatus(detail, "approved")}
              >
                <CheckCircle2 size={15} />
                {t("team.reviews.approve", { defaultValue: "批准" })}
              </button>
              <button
                type="button"
                className="team-btn team-btn-danger"
                disabled={busy}
                onClick={() => void setStatus(detail, "rejected")}
              >
                <XCircle size={15} />
                {t("team.reviews.reject", { defaultValue: "驳回" })}
              </button>
              <button
                type="button"
                className="team-btn"
                disabled={busy}
                onClick={() => void setStatus(detail, "merged")}
              >
                {t("team.reviews.merged", { defaultValue: "已合并" })}
              </button>
              <button
                type="button"
                className="team-btn team-btn-danger"
                disabled={busy}
                onClick={() => void deleteReview(detail)}
                title={t("team.reviews.delete", { defaultValue: "删除评审" })}
              >
                <Trash2 size={15} />
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
                email={detail.reviewerEmail}
                currentEmail={myEmail}
              />
              <code className="team-branch-tag">{detail.branch}</code>
              <span className="team-review-arrow">←</span>
              <code className="team-branch-tag">{detail.baseBranch}</code>
              <span className="team-detail-meta-item">
                {formatTime(detail.updatedAt)}
              </span>
            </div>
            <div className="team-status-stepper">
              {REVIEW_FLOW.map((status) => {
                const active = detail.status === status;
                const currentIndex = REVIEW_FLOW.indexOf(
                  detail.status as (typeof REVIEW_FLOW)[number],
                );
                const done = currentIndex > 0 && status === "approved";
                return (
                  <button
                    type="button"
                    key={status}
                    className={`team-status-step is-${status}${
                      active ? " is-active" : ""
                    }${done ? " is-done" : ""}`}
                    disabled={busy}
                    onClick={() => void setStatus(detail, status)}
                  >
                    {active || done ? (
                      <CheckCircle2 size={13} />
                    ) : (
                      <GitPullRequest size={13} />
                    )}
                    {STATUS_LABEL[status] ?? status}
                  </button>
                );
              })}
            </div>
            <div className="team-detail-hint">
              {t("team.reviews.checkoutHint", {
                defaultValue:
                  "评审人可在 Git 面板切换到待评审分支查看改动，用上方按钮给出结论。",
              })}
            </div>
            {detail.summary ? (
              <div className="team-detail-section">
                <div className="team-detail-section-title">
                  {t("team.reviews.summary", { defaultValue: "变更说明" })}
                </div>
                <div className="team-detail-text">{detail.summary}</div>
              </div>
            ) : null}
            <div className="team-detail-section">
              <div className="team-detail-section-title">
                {t("team.reviews.comments", { defaultValue: "评论" })}
                <span className="team-comment-count">
                  {detail.comments.length}
                </span>
              </div>
              <div className="team-comments">
                {detail.comments.length === 0 ? (
                  <div className="team-comments-empty">
                    {t("team.reviews.noComments", {
                      defaultValue: "暂无评论",
                    })}
                  </div>
                ) : (
                  detail.comments.map((comment) => (
                    <div key={comment.id} className="team-comment">
                      <div className="team-comment-head">
                        <span className="team-feed-author">
                          {memberName(team.members, comment.authorEmail)}
                        </span>
                        <span className="team-feed-time">
                          {formatTime(comment.createdAt)}
                        </span>
                        <button
                          type="button"
                          className="team-comment-delete"
                          disabled={busy}
                          onClick={() => void deleteComment(detail, comment.id)}
                          title={t("team.reviews.deleteComment", {
                            defaultValue: "删除评论",
                          })}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <div className="team-comment-body">{comment.content}</div>
                    </div>
                  ))
                )}
              </div>
              <div className="team-comment-input">
                <textarea
                  rows={2}
                  value={commentDraft}
                  placeholder={t("team.reviews.commentPlaceholder", {
                    defaultValue: "写下评审意见…",
                  })}
                  onChange={(e) => setCommentDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="team-btn team-btn-primary"
                  disabled={busy || !commentDraft.trim()}
                  onClick={() => void addComment(detail)}
                >
                  <MessageSquarePlus size={15} />
                  {t("team.reviews.comment", { defaultValue: "评论" })}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
};

// 供页签图标复用
export const TeamReviewsIcon = GitPullRequest;
