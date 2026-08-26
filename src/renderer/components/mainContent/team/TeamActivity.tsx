import {
  BookOpen,
  CircleAlert,
  GitPullRequest,
  ListTodo,
  LoaderCircle,
  Send,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TeamMessage } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import type { TeamData } from "./useTeamData";
import { TeamAvatar } from "./TeamShared";
import {
  buildTeamEvents,
  memberName,
  newId,
  nowIso,
  timeAgo,
  type TeamEvent,
} from "./teamUtils";

const EVENT_ICON: Record<string, React.JSX.Element> = {
  task: <ListTodo size={13} strokeWidth={1.8} />,
  review: <GitPullRequest size={13} strokeWidth={1.8} />,
  note: <BookOpen size={13} strokeWidth={1.8} />,
  member: <UserPlus size={13} strokeWidth={1.8} />,
};

/** 本地待确认的消息发送态（IM 风格：立即上屏 + 推送结果反馈）。 */
type OutboxItem = { record: TeamMessage; state: "sending" | "failed" };

/**
 * 团队动态：以聊天会话的形式展示团队的全部协作事件（消息、任务、评审、
 * 知识、成员加入），底部输入框可发送团队消息。视觉与主聊天面板保持一致。
 */
export const TeamActivity = ({
  team,
}: {
  team: TeamData;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [confirmTarget, setConfirmTarget] = useState<TeamEvent | null>(null);
  const [deletingKeys, setDeletingKeys] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());

  const events = useMemo(
    () =>
      buildTeamEvents({
        messages: team.messages,
        tasks: team.tasks,
        reviews: team.reviews,
        notes: team.notes,
        members: team.members,
      }),
    [team.messages, team.tasks, team.reviews, team.notes, team.members],
  );

  const outboxState = useMemo(
    () => new Map(outbox.map((item) => [item.record.id, item.state])),
    [outbox],
  );

  // 待确认消息以本地态渲染，避免与已落库的同一条重复出现
  const feedEvents = useMemo(() => {
    if (outbox.length === 0) {
      return events;
    }
    const local: TeamEvent[] = outbox.map((item) => ({
      key: `outbox-${item.record.id}`,
      at: new Date(item.record.createdAt).getTime(),
      type: "message",
      authorEmail: item.record.authorEmail,
      action: "message",
      content: item.record.content,
      refKind: "message",
      refId: item.record.id,
    }));
    const rest = events.filter(
      (e) => !(e.refKind === "message" && e.refId && outboxState.has(e.refId)),
    );
    return [...rest, ...local].sort((a, b) => a.at - b.at);
  }, [events, outbox, outboxState]);

  // 新事件到达时滚动到底部；每 30s 刷新相对时间
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [feedEvents.length]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // 后台同步成功说明失败消息已补推，清除失败标记
  useEffect(() => {
    const result = team.syncResult;
    if (result?.ok && !result.error) {
      setOutbox((prev) => prev.filter((item) => item.state !== "failed"));
    }
  }, [team.syncResult]);

  const myEmail = team.identity?.email ?? "";

  // 写入本地并推送；成功后移出 outbox，失败标记为 failed 供重发
  const pushMessage = async (record: TeamMessage): Promise<void> => {
    setOutbox((prev) =>
      prev.some((item) => item.record.id === record.id)
        ? prev.map((item) =>
            item.record.id === record.id ? { ...item, state: "sending" } : item,
          )
        : [...prev, { record, state: "sending" }],
    );
    let ok = false;
    try {
      const result = await team.publish("message", record.id, record);
      ok = result.ok;
    } catch {
      ok = false;
    }
    setOutbox((prev) =>
      ok
        ? prev.filter((item) => item.record.id !== record.id)
        : prev.map((item) =>
            item.record.id === record.id ? { ...item, state: "failed" } : item,
          ),
    );
  };

  const handleSend = (): void => {
    const content = draft.trim();
    if (!content || !team.identity?.hasIdentity) {
      return;
    }
    const record: TeamMessage = {
      id: newId("msg"),
      channel: "general",
      authorEmail: myEmail,
      content,
      createdAt: nowIso(),
    };
    setDraft("");
    void pushMessage(record);
  };

  const retrySend = (messageId: string): void => {
    const target = outbox.find((item) => item.record.id === messageId);
    if (!target || target.state === "sending") {
      return;
    }
    void pushMessage(target.record);
  };

  // 删除自己产生的一条动态：消息/知识直接删除记录，任务/评审动态移除对应历史条目。
  const deleteEvent = async (event: TeamEvent): Promise<void> => {
    if (event.authorEmail !== myEmail || event.type === "member") {
      return;
    }
    setDeletingKeys((prev) => [...prev, event.key]);
    try {
      if (event.type === "message" && event.refId) {
        setOutbox((prev) =>
          prev.filter((item) => item.record.id !== event.refId),
        );
        await team.remove("message", event.refId);
      } else if (event.type === "note" && event.refId) {
        await team.remove("note", event.refId);
      } else if (
        (event.type === "task" || event.type === "review") &&
        event.refId
      ) {
        const match = /-h-(\d+)$/.exec(event.key);
        if (!match) {
          return;
        }
        const index = Number(match[1]);
        if (event.type === "task") {
          const task = team.tasks.find((item) => item.id === event.refId);
          if (!task || index < 0 || index >= task.history.length) {
            return;
          }
          const updated = {
            ...task,
            history: task.history.filter((_, i) => i !== index),
          };
          await team.publish("task", task.id, updated);
        } else {
          const review = team.reviews.find((item) => item.id === event.refId);
          if (!review || index < 0 || index >= review.history.length) {
            return;
          }
          const updated = {
            ...review,
            history: review.history.filter((_, i) => i !== index),
          };
          await team.publish("review", review.id, updated);
        }
      }
    } catch {
      // 删除失败静默
    } finally {
      setDeletingKeys((prev) => prev.filter((key) => key !== event.key));
    }
  };

  const eventText = (event: (typeof events)[number]): string => {
    const assignee = memberName(team.members, event.detail ?? "");
    switch (event.action) {
      case "message":
        return event.content ?? "";
      case "created":
        return t("team.activity.created", {
          defaultValue: "创建了「{{title}}」",
          values: { title: event.title ?? "" },
        });
      case "assigned":
        return t("team.activity.assigned", {
          defaultValue: "把任务「{{title}}」指派给 {{assignee}}",
          values: { title: event.title ?? "", assignee },
        });
      case "status":
        return t("team.activity.status", {
          defaultValue: "更新「{{title}}」状态为 {{status}}",
          values: { title: event.title ?? "", status: event.detail ?? "" },
        });
      case "comment":
        return t("team.activity.comment", {
          defaultValue: "评论「{{title}}」：{{detail}}",
          values: { title: event.title ?? "", detail: event.detail ?? "" },
        });
      case "approved":
        return t("team.activity.approved", {
          defaultValue: "批准了评审「{{title}}」",
          values: { title: event.title ?? "" },
        });
      case "rejected":
        return t("team.activity.rejected", {
          defaultValue: "驳回了评审「{{title}}」",
          values: { title: event.title ?? "" },
        });
      case "merged":
        return t("team.activity.merged", {
          defaultValue: "合并了评审「{{title}}」",
          values: { title: event.title ?? "" },
        });
      case "joined":
        return t("team.activity.joined", {
          defaultValue: "加入了团队",
        });
      default:
        return event.content ?? "";
    }
  };

  return (
    <div className="team-feed">
      <div className="team-feed-list" ref={scrollRef}>
        {feedEvents.length === 0 ? (
          <div className="team-feed-empty">
            {t("team.activity.empty", {
              defaultValue:
                "还没有团队动态。创建任务、发起评审或发一条消息开始协作吧。",
            })}
          </div>
        ) : (
          feedEvents.map((event) => {
            const isMessage = event.action === "message";
            const authorName = memberName(team.members, event.authorEmail);
            const member = team.members.find(
              (m) => m.email === event.authorEmail,
            );
            const isMine = event.authorEmail === myEmail;
            const sendState =
              isMessage && event.refId
                ? outboxState.get(event.refId)
                : undefined;
            const isDeleting = deletingKeys.includes(event.key);
            const deleteButton = isDeleting ? (
              <span
                className="team-feed-delete is-busy"
                title={t("team.activity.deleting", {
                  defaultValue: "删除中…",
                })}
              >
                <LoaderCircle size={12} />
              </span>
            ) : (
              <button
                type="button"
                className="team-feed-delete"
                onClick={() => setConfirmTarget(event)}
                title={t("team.activity.delete", { defaultValue: "删除" })}
              >
                <Trash2 size={12} />
              </button>
            );
            return (
              <div
                key={event.key}
                className={`team-feed-item${isMessage ? " is-message" : " is-event"}${
                  isMessage && isMine ? " is-mine" : ""
                }`}
              >
                {isMessage ? (
                  <>
                    <TeamAvatar
                      name={authorName}
                      seed={member?.avatarSeed ?? event.authorEmail}
                      size={30}
                    />
                    <div className="team-feed-message">
                      <div className="team-feed-message-meta">
                        {isMine && sendState !== "sending"
                          ? deleteButton
                          : null}
                        <span className="team-feed-author">{authorName}</span>
                        <span className="team-feed-time">
                          {timeAgo(event.at, now)}
                        </span>
                      </div>
                      <div className="team-feed-bubble-row">
                        {sendState === "sending" ? (
                          <span
                            className="team-feed-send-state is-sending"
                            title={t("team.activity.sending", {
                              defaultValue: "发送中…",
                            })}
                          >
                            <LoaderCircle size={13} />
                          </span>
                        ) : null}
                        {sendState === "failed" ? (
                          <button
                            type="button"
                            className="team-feed-send-state is-failed"
                            onClick={() => retrySend(event.refId ?? "")}
                            title={t("team.activity.retry", {
                              defaultValue: "发送失败，点击重发",
                            })}
                          >
                            <CircleAlert size={14} />
                          </button>
                        ) : null}
                        <div className="team-feed-message-bubble">
                          {eventText(event)}
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="team-feed-event">
                    <span className="team-feed-event-icon">
                      {EVENT_ICON[event.type]}
                    </span>
                    <span className="team-feed-event-text">
                      <span className="team-feed-author">{authorName}</span>{" "}
                      {eventText(event)}
                    </span>
                    <span className="team-feed-time">
                      {timeAgo(event.at, now)}
                    </span>
                    {isMine && event.type !== "member" ? deleteButton : null}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="team-feed-input">
        <textarea
          value={draft}
          rows={1}
          placeholder={t("team.activity.placeholder", {
            defaultValue: "发一条团队消息…（Enter 发送，Shift+Enter 换行）",
          })}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          type="button"
          className="team-feed-send"
          disabled={!draft.trim()}
          onClick={handleSend}
          title={t("team.activity.send", { defaultValue: "发送" })}
        >
          <Send size={15} />
        </button>
      </div>
      <ConfirmDialog
        open={confirmTarget !== null}
        variant="danger"
        title={t("team.activity.deleteTitle", { defaultValue: "删除动态" })}
        message={t("team.activity.deleteMessage", {
          defaultValue: "删除后会同步给团队其他成员，且无法恢复。确定删除吗？",
        })}
        confirmLabel={t("team.activity.delete", { defaultValue: "删除" })}
        cancelLabel={t("common.cancel", { defaultValue: "取消" })}
        onConfirm={() => {
          const target = confirmTarget;
          setConfirmTarget(null);
          if (target) {
            void deleteEvent(target);
          }
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
};
