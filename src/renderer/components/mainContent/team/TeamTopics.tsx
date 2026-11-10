import {
  CheckCircle2,
  Loader2,
  Lock,
  MessageSquarePlus,
  Pencil,
  Plus,
  Save,
  ShieldAlert,
  Trash2,
  Vote,
  XCircle,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { TeamTopic } from "../../../../preload";
import { useI18n } from "../../../i18n";
import {
  CustomSelect,
  type CustomSelectOption,
} from "../../common/CustomSelect";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { Modal } from "../../common/Modal";
import type { TeamData } from "./useTeamData";
import {
  mdToPlain,
  TeamMarkdownEditor,
  TeamNoteMarkdown,
} from "./TeamMarkdownEditor";
import {
  TeamAvatar,
  TeamEmpty,
  TeamErrorNotice,
  TeamMemberChip,
} from "./TeamShared";
import {
  formatTime,
  memberName,
  memberSeed,
  newId,
  nowIso,
  topicOutcome,
} from "./teamUtils";

type TopicDraft = {
  title: string;
  taskId: string;
  description: string;
};

const EMPTY_DRAFT: TopicDraft = {
  title: "",
  taskId: "",
  description: "",
};

type VetoTarget = { topicId: string; decision: "open" | "closed" };

/**
 * 团队议题：成员投票决定议题开启 / 关闭，票数实时说话；队长可一票否决，
 * 否决后最终结论锁定。
 */
export const TeamTopics = ({ team }: { team: TeamData }): React.JSX.Element => {
  const { t } = useI18n();
  const [formOpen, setFormOpen] = useState(false);
  const [editingTopic, setEditingTopic] = useState<TeamTopic | null>(null);
  const [pendingId, setPendingId] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TopicDraft>(EMPTY_DRAFT);
  const [commentDraft, setCommentDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [vetoTarget, setVetoTarget] = useState<VetoTarget | null>(null);
  const [deleteTopicTarget, setDeleteTopicTarget] = useState<TeamTopic | null>(
    null,
  );
  const [deleteCommentTarget, setDeleteCommentTarget] = useState<{
    topicId: string;
    commentId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);

  const myPeerId = team.me.peerId;
  const isHost = team.role === "host";
  // 详情始终取最新记录：成员投票 / 评论后无需手动同步副本
  const detail = detailId
    ? (team.topics.find((topic) => topic.id === detailId) ?? null)
    : null;

  const choiceLabel = (choice: "open" | "closed"): string =>
    choice === "open"
      ? t("team.topics.open", { defaultValue: "开启" })
      : t("team.topics.closed", { defaultValue: "关闭" });

  const taskOptions: CustomSelectOption[] = useMemo(
    () => [
      {
        value: "",
        label: t("team.topics.noTask", { defaultValue: "（不关联任务）" }),
      },
      ...team.tasks.map((task) => ({ value: task.id, label: task.title })),
    ],
    [team.tasks, t],
  );

  const taskTitle = (taskId: string | null): string =>
    taskId ? (team.tasks.find((task) => task.id === taskId)?.title ?? "") : "";

  const openCreate = (): void => {
    setEditingTopic(null);
    setPendingId(newId("topic"));
    setDraft(EMPTY_DRAFT);
    setError(null);
    setFormOpen(true);
  };

  /** 编辑议题：复用同一表单，说明区使用 Markdown 编辑器。 */
  const openEdit = (topic: TeamTopic): void => {
    setEditingTopic(topic);
    setPendingId(topic.id);
    setDraft({
      title: topic.title,
      taskId: topic.taskId ?? "",
      description: topic.description,
    });
    setError(null);
    setFormOpen(true);
  };

  const handleSave = async (): Promise<void> => {
    if (!draft.title.trim()) {
      setError(t("team.topics.errorTitle", { defaultValue: "请输入议题标题" }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const now = nowIso();
      if (editingTopic) {
        // 以记录最新态为基准，避免覆盖其他成员的并发投票 / 评论
        const latest =
          team.topics.find((item) => item.id === editingTopic.id) ??
          editingTopic;
        const updated: TeamTopic = {
          ...latest,
          title: draft.title.trim(),
          description: draft.description,
          taskId: draft.taskId || null,
          updatedAt: now,
          history: [
            ...latest.history,
            {
              at: now,
              by: myPeerId,
              action: "updated",
              detail: draft.title.trim(),
            },
          ],
        };
        await team.publish("topic", updated.id, updated);
        setDetailId(updated.id);
      } else {
        const record: TeamTopic = {
          id: pendingId || newId("topic"),
          title: draft.title.trim(),
          description: draft.description,
          taskId: draft.taskId || null,
          creatorPeerId: myPeerId,
          votes: [],
          veto: null,
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
          comments: [],
        };
        await team.publish("topic", record.id, record);
        setDetailId(record.id);
      }
      setFormOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const publishPatch = async (
    topic: TeamTopic,
    patch: Partial<TeamTopic>,
    history: { action: string; detail: string },
  ): Promise<void> => {
    const now = nowIso();
    const updated: TeamTopic = {
      ...topic,
      ...patch,
      updatedAt: now,
      history: [...topic.history, { at: now, by: myPeerId, ...history }],
    };
    await team.publish("topic", topic.id, updated);
  };

  /** 投票 / 改票：每人一票，否决后不再接受投票。 */
  const castVote = async (
    topic: TeamTopic,
    choice: "open" | "closed",
  ): Promise<void> => {
    if (busy || topic.veto) {
      return;
    }
    setBusy(true);
    try {
      const now = nowIso();
      const exists = topic.votes.some((vote) => vote.peerId === myPeerId);
      const votes = exists
        ? topic.votes.map((vote) =>
            vote.peerId === myPeerId
              ? { ...vote, choice, updatedAt: now }
              : vote,
          )
        : [...topic.votes, { peerId: myPeerId, choice, updatedAt: now }];
      await publishPatch(topic, { votes }, { action: "vote", detail: choice });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 队长一票否决：写下即锁定最终结论。 */
  const applyVeto = async (): Promise<void> => {
    if (!vetoTarget) {
      return;
    }
    const topic = team.topics.find((item) => item.id === vetoTarget.topicId);
    if (!topic) {
      setVetoTarget(null);
      return;
    }
    setBusy(true);
    try {
      await publishPatch(
        topic,
        {
          veto: { by: myPeerId, decision: vetoTarget.decision, at: nowIso() },
        },
        { action: "veto", detail: vetoTarget.decision },
      );
      setVetoTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addComment = async (topic: TeamTopic): Promise<void> => {
    const content = commentDraft.trim();
    if (!content || busy) {
      return;
    }
    setBusy(true);
    try {
      const now = nowIso();
      await publishPatch(
        topic,
        {
          comments: [
            ...topic.comments,
            {
              id: newId("cmt"),
              authorPeerId: myPeerId,
              content,
              createdAt: now,
            },
          ],
        },
        { action: "comment", detail: content },
      );
      setCommentDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteComment = async (
    topic: TeamTopic,
    commentId: string,
  ): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await publishPatch(
        topic,
        { comments: topic.comments.filter((c) => c.id !== commentId) },
        { action: "comment_deleted", detail: "" },
      );
      setDeleteCommentTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteTopic = async (topic: TeamTopic): Promise<void> => {
    setDeleting(true);
    try {
      await team.remove("topic", topic.id);
      // 顺带清理该议题名下的附件（Markdown 说明中的图片引用）
      void team.deleteMedia(topic.id).catch(() => undefined);
      setDetailId(null);
      setDeleteTopicTarget(null);
    } catch {
      // 删除失败静默
    } finally {
      setDeleting(false);
    }
  };

  const { voting, decided } = useMemo(() => {
    const votingList: TeamTopic[] = [];
    const decidedList: TeamTopic[] = [];
    for (const topic of team.topics) {
      (topic.veto ? decidedList : votingList).push(topic);
    }
    const sortByTime = (a: TeamTopic, b: TeamTopic) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    votingList.sort(sortByTime);
    decidedList.sort(sortByTime);
    return { voting: votingList, decided: decidedList };
  }, [team.topics]);

  const renderCard = (topic: TeamTopic): React.JSX.Element => {
    const outcome = topicOutcome(topic);
    const badgeClass = outcome.locked ? `is-${outcome.decision}` : "is-voting";
    const badgeText = outcome.locked
      ? choiceLabel(outcome.decision ?? "closed")
      : t("team.topics.voting", { defaultValue: "投票中" });
    return (
      <button
        type="button"
        key={topic.id}
        className="team-topic-card"
        onClick={() => setDetailId(topic.id)}
      >
        <div className="team-task-card-top">
          <span className="team-topic-icon">
            {outcome.locked ? <Lock size={14} /> : <Vote size={14} />}
          </span>
          <span className="team-task-card-title">{topic.title}</span>
          <span className={`team-status ${badgeClass}`}>{badgeText}</span>
        </div>
        {topic.description ? (
          <div className="team-task-card-desc">
            {mdToPlain(topic.description)}
          </div>
        ) : null}
        <div className="team-task-card-bottom">
          <TeamMemberChip
            members={team.members}
            peerId={topic.creatorPeerId}
            currentPeerId={myPeerId}
          />
          <span className="team-topic-tally">
            <span className="is-open">
              {choiceLabel("open")} {outcome.open}
            </span>
            <span className="is-closed">
              {choiceLabel("closed")} {outcome.closed}
            </span>
          </span>
          <span className="team-comment-count">
            {t("team.topics.commentCount", {
              defaultValue: "{{count}} 条评论",
              values: { count: topic.comments.length },
            })}
          </span>
        </div>
      </button>
    );
  };

  const renderGroup = (
    key: string,
    title: string,
    items: TeamTopic[],
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

  const detailOutcome = detail ? topicOutcome(detail) : null;
  const myVote = detail?.votes.find((vote) => vote.peerId === myPeerId);
  const outcomeClass = detailOutcome?.locked
    ? `is-locked is-${detailOutcome.decision}`
    : detailOutcome?.decision
      ? `is-live is-${detailOutcome.decision}`
      : "is-none";

  return (
    <div className="team-tasks">
      <div className="team-tab-toolbar">
        <span className="team-tab-title">
          {t("team.topics.title", { defaultValue: "议题" })}
        </span>
        <button
          type="button"
          className="team-btn team-btn-primary"
          onClick={() => openCreate()}
        >
          <Plus size={15} />
          {t("team.topics.new", { defaultValue: "发起议题" })}
        </button>
      </div>

      {team.topics.length === 0 ? (
        <TeamEmpty
          icon={<Vote size={28} strokeWidth={1.4} />}
          text={t("team.topics.empty", {
            defaultValue:
              "还没有议题。发起一个议题，让团队投票决定它该开启还是关闭。",
          })}
        />
      ) : (
        <div className="team-task-groups">
          {renderGroup(
            "voting",
            t("team.topics.groupVoting", { defaultValue: "讨论中" }),
            voting,
          )}
          {renderGroup(
            "decided",
            t("team.topics.groupDecided", { defaultValue: "已定案" }),
            decided,
          )}
        </div>
      )}

      <Modal
        open={formOpen}
        title={
          editingTopic
            ? t("team.topics.edit", { defaultValue: "编辑议题" })
            : t("team.topics.new", { defaultValue: "发起议题" })
        }
        closeLabel={t("common.close", { defaultValue: "关闭" })}
        onClose={() => setFormOpen(false)}
        className="team-md-modal"
        footer={
          <>
            <button
              type="button"
              className="team-btn team-btn-primary"
              disabled={busy}
              onClick={() => void handleSave()}
            >
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : editingTopic ? (
                <Save size={15} />
              ) : null}
              {editingTopic
                ? t("common.save", { defaultValue: "保存" })
                : t("team.topics.create", { defaultValue: "发布议题" })}
            </button>
          </>
        }
      >
        <div className="team-form">
          <label className="team-form-label">
            {t("team.topics.titleField", { defaultValue: "标题" })}
            <input
              className="team-form-input"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              autoFocus
            />
          </label>
          {team.tasks.length > 0 ? (
            <label className="team-form-label">
              {t("team.topics.task", { defaultValue: "关联任务" })}
              <CustomSelect
                value={draft.taskId}
                options={taskOptions}
                onChange={(v) => setDraft({ ...draft, taskId: v })}
                filterable
                portal
              />
            </label>
          ) : null}
          <div className="team-form-label team-form-label-grow">
            {t("team.topics.description", { defaultValue: "议题说明" })}
            <TeamMarkdownEditor
              value={draft.description}
              onChange={(next) =>
                setDraft((prev) => ({ ...prev, description: next }))
              }
              noteId={pendingId}
              saveMedia={team.saveMedia}
              readMedia={team.readMedia}
              placeholder={t("team.md.placeholder", {
                defaultValue:
                  "支持 Markdown 语法（**加粗**、`代码`、- 列表等），可直接粘贴或拖入图片…",
              })}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={detail !== null}
        title={detail?.title ?? ""}
        closeLabel={t("common.close", { defaultValue: "关闭" })}
        onClose={() => setDetailId(null)}
        size="large"
        footer={
          detail ? (
            <div className="team-detail-actions">
              <button
                type="button"
                className="team-btn"
                disabled={busy || deleting}
                onClick={() => openEdit(detail)}
                title={t("team.topics.edit", { defaultValue: "编辑议题" })}
              >
                <Pencil size={15} />
                {t("common.edit", { defaultValue: "编辑" })}
              </button>
              {isHost && !detail.veto ? (
                <>
                  <button
                    type="button"
                    className="team-btn team-btn-success"
                    disabled={busy || deleting}
                    onClick={() =>
                      setVetoTarget({ topicId: detail.id, decision: "open" })
                    }
                    title={t("team.topics.vetoHint", {
                      defaultValue:
                        "一票否决后最终结论立即锁定，不再随投票变化，且无法撤销。",
                    })}
                  >
                    <ShieldAlert size={15} />
                    {t("team.topics.vetoOpen", { defaultValue: "否决为开启" })}
                  </button>
                  <button
                    type="button"
                    className="team-btn team-btn-danger"
                    disabled={busy || deleting}
                    onClick={() =>
                      setVetoTarget({ topicId: detail.id, decision: "closed" })
                    }
                    title={t("team.topics.vetoHint", {
                      defaultValue:
                        "一票否决后最终结论立即锁定，不再随投票变化，且无法撤销。",
                    })}
                  >
                    <ShieldAlert size={15} />
                    {t("team.topics.vetoClosed", {
                      defaultValue: "否决为关闭",
                    })}
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="team-btn team-btn-danger"
                disabled={busy || deleting}
                onClick={() => setDeleteTopicTarget(detail)}
                title={t("team.topics.delete", { defaultValue: "删除议题" })}
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
        {detail && detailOutcome ? (
          <div className="team-detail">
            <div className="team-detail-meta">
              <TeamMemberChip
                members={team.members}
                peerId={detail.creatorPeerId}
                currentPeerId={myPeerId}
              />
              <span className="team-detail-meta-item">
                {formatTime(detail.updatedAt)}
              </span>
              {detail.taskId ? (
                <span className="team-detail-meta-item">
                  {t("team.topics.linkedTask", {
                    defaultValue: "关联任务：{{title}}",
                    values: { title: taskTitle(detail.taskId) },
                  })}
                </span>
              ) : null}
            </div>

            <div className={`team-topic-outcome ${outcomeClass}`}>
              <span className="team-topic-outcome-label">
                {detailOutcome.locked
                  ? t("team.topics.finalOutcome", { defaultValue: "最终结论" })
                  : t("team.topics.currentOutcome", {
                      defaultValue: "当前结论",
                    })}
              </span>
              <span className="team-topic-outcome-value">
                {detailOutcome.decision
                  ? choiceLabel(detailOutcome.decision)
                  : t("team.topics.noOutcome", { defaultValue: "尚未有结论" })}
              </span>
              <span className="team-topic-outcome-hint">
                {detailOutcome.locked && detail.veto
                  ? t("team.topics.vetoedBy", {
                      defaultValue: "由 {{name}} 一票否决，结论已锁定",
                      values: {
                        name: memberName(team.members, detail.veto.by),
                      },
                    })
                  : t("team.topics.liveHint", {
                      defaultValue:
                        "票数实时说话：开启票多即开启、关闭票多即关闭；队长可一票否决",
                    })}
              </span>
            </div>

            {detail.description ? (
              <div className="team-detail-section">
                <div className="team-detail-section-title">
                  {t("team.topics.description", { defaultValue: "议题说明" })}
                </div>
                <div className="team-note-markdown">
                  <TeamNoteMarkdown
                    className="context-compaction-markdown"
                    content={detail.description}
                    readMedia={team.readMedia}
                  />
                </div>
              </div>
            ) : null}

            <div className="team-detail-section">
              <div className="team-detail-section-title">
                {t("team.topics.votes", { defaultValue: "投票" })}
                <span className="team-comment-count">
                  {t("team.topics.voterCount", {
                    defaultValue: "{{count}} 人已投",
                    values: { count: detail.votes.length },
                  })}
                </span>
              </div>
              <div className="team-topic-vote-actions">
                <button
                  type="button"
                  className={`team-topic-vote is-open${
                    myVote?.choice === "open" ? " is-active" : ""
                  }`}
                  disabled={busy || detailOutcome.locked}
                  onClick={() => void castVote(detail, "open")}
                >
                  <CheckCircle2 size={15} />
                  {choiceLabel("open")}
                  <span className="team-topic-vote-count">
                    {detailOutcome.open}
                  </span>
                </button>
                <button
                  type="button"
                  className={`team-topic-vote is-closed${
                    myVote?.choice === "closed" ? " is-active" : ""
                  }`}
                  disabled={busy || detailOutcome.locked}
                  onClick={() => void castVote(detail, "closed")}
                >
                  <XCircle size={15} />
                  {choiceLabel("closed")}
                  <span className="team-topic-vote-count">
                    {detailOutcome.closed}
                  </span>
                </button>
              </div>
              {detail.votes.length > 0 ? (
                <div className="team-topic-voters">
                  {detail.votes.map((vote) => (
                    <span
                      key={vote.peerId}
                      className={`team-topic-voter is-${vote.choice}`}
                    >
                      <TeamAvatar
                        name={memberName(team.members, vote.peerId)}
                        seed={memberSeed(team.members, vote.peerId)}
                        size={20}
                      />
                      <span>{memberName(team.members, vote.peerId)}</span>
                      <span className="team-topic-voter-choice">
                        {choiceLabel(vote.choice)}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="team-comments-empty">
                  {t("team.topics.noVotes", { defaultValue: "还没有人投票" })}
                </div>
              )}
            </div>

            <div className="team-detail-section">
              <div className="team-detail-section-title">
                {t("team.topics.comments", { defaultValue: "评论" })}
                <span className="team-comment-count">
                  {detail.comments.length}
                </span>
              </div>
              <div className="team-comments">
                {detail.comments.length === 0 ? (
                  <div className="team-comments-empty">
                    {t("team.topics.noComments", { defaultValue: "暂无评论" })}
                  </div>
                ) : (
                  detail.comments.map((comment) => (
                    <div key={comment.id} className="team-comment">
                      <div className="team-comment-head">
                        <span className="team-feed-author">
                          {memberName(team.members, comment.authorPeerId)}
                        </span>
                        <span className="team-feed-time">
                          {formatTime(comment.createdAt)}
                        </span>
                        <button
                          type="button"
                          className="team-comment-delete"
                          disabled={busy || deleting}
                          onClick={() =>
                            setDeleteCommentTarget({
                              topicId: detail.id,
                              commentId: comment.id,
                            })
                          }
                          title={t("team.topics.deleteComment", {
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
                  placeholder={t("team.topics.commentPlaceholder", {
                    defaultValue: "写下你的看法…",
                  })}
                  onChange={(e) => setCommentDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="team-btn team-btn-primary"
                  disabled={busy || deleting || !commentDraft.trim()}
                  onClick={() => void addComment(detail)}
                >
                  <MessageSquarePlus size={15} />
                  {t("team.topics.comment", { defaultValue: "评论" })}
                </button>
              </div>
            </div>

            {detail.history.length > 0 ? (
              <div className="team-detail-section">
                <div className="team-detail-section-title">
                  {t("team.tasks.history", { defaultValue: "动态" })}
                </div>
                <div className="team-detail-history">
                  {detail.history.map((entry, index) => (
                    <div key={index} className="team-detail-history-item">
                      <span className="team-detail-history-author">
                        {memberName(team.members, entry.by)}
                      </span>
                      <span className="team-detail-history-action">
                        {entry.action}
                      </span>
                      <span className="team-detail-history-detail">
                        {entry.detail === "open" || entry.detail === "closed"
                          ? choiceLabel(entry.detail)
                          : entry.detail}
                      </span>
                      <span className="team-detail-history-time">
                        {formatTime(entry.at)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={vetoTarget !== null}
        title={t("team.topics.vetoTitle", { defaultValue: "确认一票否决？" })}
        message={t("team.topics.vetoMessage", {
          defaultValue:
            "议题「{{title}}」的最终结论将锁定为「{{decision}}」，且无法撤销。",
          values: {
            title:
              team.topics.find((topic) => topic.id === vetoTarget?.topicId)
                ?.title ?? "",
            decision: vetoTarget ? choiceLabel(vetoTarget.decision) : "",
          },
        })}
        confirmLabel={t("team.topics.vetoConfirm", {
          defaultValue: "确认否决",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "取消" })}
        variant="danger"
        isConfirming={busy}
        onConfirm={() => void applyVeto()}
        onCancel={() => setVetoTarget(null)}
      />
      <ConfirmDialog
        open={deleteTopicTarget !== null}
        variant="danger"
        title={t("team.topics.deleteConfirmTitle", {
          defaultValue: "删除议题？",
        })}
        message={t("team.topics.deleteConfirmMessage", {
          defaultValue: "议题「{{title}}」及其投票、评论将被删除，且无法恢复。",
          values: { title: deleteTopicTarget?.title ?? "" },
        })}
        confirmLabel={t("team.topics.delete", { defaultValue: "删除议题" })}
        cancelLabel={t("common.cancel", { defaultValue: "取消" })}
        isConfirming={deleting}
        onConfirm={() => {
          const target = deleteTopicTarget;
          if (target) {
            void deleteTopic(target);
          }
        }}
        onCancel={() => setDeleteTopicTarget(null)}
      />
      <ConfirmDialog
        open={deleteCommentTarget !== null}
        variant="danger"
        title={t("team.topics.deleteCommentConfirmTitle", {
          defaultValue: "删除评论？",
        })}
        message={t("team.topics.deleteCommentConfirmMessage", {
          defaultValue: "该评论将被删除，且无法恢复。",
        })}
        confirmLabel={t("team.topics.deleteComment", {
          defaultValue: "删除评论",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "取消" })}
        isConfirming={busy}
        onConfirm={() => {
          const target = deleteCommentTarget;
          if (!target) {
            return;
          }
          const topic = team.topics.find((item) => item.id === target.topicId);
          if (!topic) {
            setDeleteCommentTarget(null);
            return;
          }
          void deleteComment(topic, target.commentId);
        }}
        onCancel={() => setDeleteCommentTarget(null)}
      />
      <TeamErrorNotice message={error} onDismiss={clearError} />
    </div>
  );
};
