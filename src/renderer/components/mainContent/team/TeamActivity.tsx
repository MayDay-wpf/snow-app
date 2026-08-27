import {
  BookOpen,
  CircleAlert,
  Download,
  FileText,
  GitPullRequest,
  ListTodo,
  LoaderCircle,
  Paperclip,
  Send,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TeamMessage, TeamMessageAttachment } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { dataUrlToBlob, saveBlobToFile } from "../../../utils/imageDownload";
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

/** 草稿区待发送附件（dataUrl 在内存中，点发送才落盘上传）。 */
type PendingFile = {
  name: string;
  size: number;
  isImage: boolean;
  dataUrl: string;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PENDING_FILES = 9;

/** 与 Rust 侧图片白名单保持一致 */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"];
/** 与 Rust 侧附件黑名单保持一致 */
const BLOCKED_EXTS = [
  "exe",
  "dll",
  "so",
  "dylib",
  "bat",
  "cmd",
  "com",
  "msi",
  "scr",
  "vbs",
  "vbe",
  "ps1",
  "psm1",
  "app",
  "deb",
  "rpm",
  "pkg",
  "dmg",
  "reg",
  "inf",
];

const extOf = (name: string): string =>
  (/\.([^.]+)$/.exec(name)?.[1] ?? "").toLowerCase();

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

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
  // 附件：选择后在草稿区预览，点发送才写入仓库媒体目录
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 消息附件 data URL 缓存（气泡缩略图与 lightbox 共用）
  const mediaCacheRef = useRef(new Map<string, string>());

  const loadMediaUrl = async (rel: string): Promise<string> => {
    const cached = mediaCacheRef.current.get(rel);
    if (cached) {
      return cached;
    }
    const url = await window.snow.teamMediaRead(team.repoPath, rel);
    mediaCacheRef.current.set(rel, url);
    return url;
  };

  const pickFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0 || !team.identity?.hasIdentity) {
      return;
    }
    for (const file of Array.from(files)) {
      if (pendingFiles.length + 1 > MAX_PENDING_FILES) {
        setNotice(
          t("team.activity.tooManyFiles", {
            defaultValue: "一条消息最多 {{count}} 个附件",
            values: { count: MAX_PENDING_FILES },
          }),
        );
        break;
      }
      const ext = extOf(file.name);
      if (BLOCKED_EXTS.includes(ext)) {
        setNotice(
          t("team.activity.fileBlocked", {
            defaultValue: "{{name}} 类型不支持发送",
            values: { name: file.name },
          }),
        );
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setNotice(
          t("team.activity.fileTooLarge", {
            defaultValue: "{{name}} 超过 5MB，无法发送",
            values: { name: file.name },
          }),
        );
        continue;
      }
      try {
        const dataUrl = await readAsDataUrl(file);
        setPendingFiles((prev) =>
          prev.length >= MAX_PENDING_FILES
            ? prev
            : [
                ...prev,
                {
                  name: file.name,
                  size: file.size,
                  isImage: IMAGE_EXTS.includes(ext),
                  dataUrl,
                },
              ],
        );
      } catch {
        setNotice(
          t("team.activity.fileReadFailed", {
            defaultValue: "文件读取失败",
          }),
        );
      }
    }
  };

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
      attachments: item.record.attachments ?? [],
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

  // 发送：先把草稿附件写入仓库媒体目录，再发布消息记录
  const handleSend = async (): Promise<void> => {
    const content = draft.trim();
    if ((!content && pendingFiles.length === 0) || uploading) {
      return;
    }
    if (!team.identity?.hasIdentity || !team.repoPath) {
      return;
    }
    const msgId = newId("msg");
    let attachments: TeamMessageAttachment[] = [];
    if (pendingFiles.length > 0) {
      setUploading(true);
      try {
        attachments = await Promise.all(
          pendingFiles.map(async (file) => {
            const rel = file.isImage
              ? await window.snow.teamMediaSave(
                  team.repoPath,
                  msgId,
                  file.name,
                  file.dataUrl,
                )
              : await window.snow.teamFileSave(
                  team.repoPath,
                  msgId,
                  file.name,
                  file.dataUrl,
                );
            return {
              name: file.name,
              path: rel,
              size: file.size,
              isImage: file.isImage,
            };
          }),
        );
      } catch {
        setNotice(
          t("team.activity.fileUploadFailed", {
            defaultValue: "附件上传失败，请重试",
          }),
        );
        // 清掉本次部分上传成功的文件，避免仓库残留无主媒体
        void window.snow
          .teamMediaDelete(team.repoPath, msgId)
          .catch(() => undefined);
        return;
      } finally {
        setUploading(false);
      }
    }
    const record: TeamMessage = {
      id: msgId,
      channel: "general",
      authorEmail: myEmail,
      content,
      createdAt: nowIso(),
    };
    if (attachments.length > 0) {
      record.attachments = attachments;
    }
    setDraft("");
    setPendingFiles([]);
    void pushMessage(record);
  };

  // Esc 关闭图片预览
  useEffect(() => {
    if (!previewSrc) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setPreviewSrc(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewSrc]);

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
        // 顺带清理该消息的附件媒体目录（无目录时 Rust 侧幂等返回）
        void window.snow
          .teamMediaDelete(team.repoPath, event.refId)
          .catch(() => undefined);
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
                          {(event.content ?? "").trim() ? (
                            <div className="team-feed-message-text">
                              {eventText(event)}
                            </div>
                          ) : null}
                          {event.attachments && event.attachments.length > 0 ? (
                            <MessageAttachments
                              repoPath={team.repoPath}
                              attachments={event.attachments}
                              cache={mediaCacheRef.current}
                              onPreview={(src) => setPreviewSrc(src)}
                            />
                          ) : null}
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
      <div className="team-feed-composer">
        {notice ? (
          <div className="team-feed-notice">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              title={t("common.close", { defaultValue: "关闭" })}
            >
              <X size={12} />
            </button>
          </div>
        ) : null}
        {pendingFiles.length > 0 ? (
          <div className="team-feed-pending">
            {pendingFiles.map((file, index) => (
              <div
                key={`${file.name}-${index}`}
                className="team-feed-pending-item"
              >
                {file.isImage ? (
                  <img src={file.dataUrl} alt={file.name} />
                ) : (
                  <span className="team-feed-pending-icon">
                    <FileText size={16} />
                  </span>
                )}
                <span className="team-feed-pending-name" title={file.name}>
                  {file.name}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPendingFiles((prev) =>
                      prev.filter((_, i) => i !== index),
                    )
                  }
                  title={t("team.activity.removeFile", {
                    defaultValue: "移除",
                  })}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {uploading ? (
              <span className="team-feed-uploading">
                <LoaderCircle size={13} />
                {t("team.activity.uploading", { defaultValue: "上传中…" })}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="team-feed-input">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void pickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="team-feed-tools">
            <button
              type="button"
              className="team-feed-tool-btn"
              disabled={!team.identity?.hasIdentity || uploading}
              onClick={() => fileInputRef.current?.click()}
              title={t("team.activity.attachFile", {
                defaultValue: "发送附件",
              })}
            >
              <Paperclip size={16} />
            </button>
          </div>
          <textarea
            value={draft}
            rows={1}
            placeholder={t("team.activity.placeholder", {
              defaultValue: "发一条团队消息…",
            })}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              // 截图/复制的文件直接进附件，文本仍走默认粘贴
              const files = e.clipboardData?.files;
              if (files && files.length > 0) {
                e.preventDefault();
                void pickFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <button
            type="button"
            className="team-feed-send"
            disabled={(!draft.trim() && pendingFiles.length === 0) || uploading}
            onClick={() => void handleSend()}
            title={t("team.activity.send", { defaultValue: "发送" })}
          >
            {uploading ? <LoaderCircle size={15} /> : <Send size={15} />}
          </button>
        </div>
      </div>
      {previewSrc ? (
        <div
          className="team-feed-lightbox"
          onClick={() => setPreviewSrc(null)}
          role="presentation"
        >
          <img src={previewSrc} alt="" />
        </div>
      ) : null}
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

/** 附件体积的友好描述（KB/MB）。 */
const formatSize = (size: number): string =>
  size >= 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;

/**
 * 消息附件渲染：图片懒加载缩略图（点击预览），普通文件显示可下载卡片。
 */
const MessageAttachments = ({
  repoPath,
  attachments,
  cache,
  onPreview,
}: {
  repoPath: string;
  attachments: TeamMessageAttachment[];
  cache: Map<string, string>;
  onPreview: (src: string) => void;
}): React.JSX.Element | null => {
  const images = attachments.filter((a) => a.isImage);
  const files = attachments.filter((a) => !a.isImage);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    for (const item of images) {
      if (imageUrls[item.path]) {
        continue;
      }
      const cached = cache.get(item.path);
      if (cached) {
        setImageUrls((prev) => ({ ...prev, [item.path]: cached }));
        continue;
      }
      void window.snow
        .teamMediaRead(repoPath, item.path)
        .then((url) => {
          if (cancelled) {
            return;
          }
          cache.set(item.path, url);
          setImageUrls((prev) => ({ ...prev, [item.path]: url }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, attachments]);

  const downloadFile = async (item: TeamMessageAttachment): Promise<void> => {
    try {
      const url =
        cache.get(item.path) ??
        (await window.snow.teamMediaRead(repoPath, item.path));
      if (!cache.has(item.path)) {
        cache.set(item.path, url);
      }
      await saveBlobToFile(dataUrlToBlob(url), item.name);
    } catch {
      // 读取失败静默
    }
  };

  if (images.length === 0 && files.length === 0) {
    return null;
  }
  return (
    <div className="team-feed-attachments">
      {images.length > 0 ? (
        <div className="team-feed-attach-images">
          {images.map((item) =>
            imageUrls[item.path] ? (
              <button
                key={item.path}
                type="button"
                className="team-feed-attach-thumb"
                onClick={() => onPreview(imageUrls[item.path])}
                title={item.name}
              >
                <img src={imageUrls[item.path]} alt={item.name} />
              </button>
            ) : (
              <span
                key={item.path}
                className="team-feed-attach-thumb is-loading"
              >
                <LoaderCircle size={14} />
              </span>
            ),
          )}
        </div>
      ) : null}
      {files.map((item) => (
        <button
          key={item.path}
          type="button"
          className="team-feed-attach-file"
          onClick={() => void downloadFile(item)}
          title={item.name}
        >
          <FileText size={15} />
          <span className="team-feed-attach-file-name">{item.name}</span>
          <span className="team-feed-attach-file-size">
            {formatSize(item.size)}
          </span>
          <Download size={13} />
        </button>
      ))}
    </div>
  );
};
