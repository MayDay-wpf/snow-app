import { BookOpen, Loader2, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import type { TeamNote } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { Modal } from "../../common/Modal";
import {
  isImageOnlyNote,
  mdToPlain,
  TeamMarkdownEditor,
  TeamNoteMarkdown,
} from "./TeamMarkdownEditor";
import type { TeamData } from "./useTeamData";
import { TeamEmpty, TeamMemberChip } from "./TeamShared";
import { formatTime, newId, nowIso, timeAgo } from "./teamUtils";

const splitTags = (value: string): string[] =>
  value
    .split(/[,，\s]/)
    .map((s) => s.trim())
    .filter(Boolean);

export const TeamNotes = ({ team }: { team: TeamData }): React.JSX.Element => {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [detail, setDetail] = useState<TeamNote | null>(null);
  const [pendingId, setPendingId] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const myEmail = team.identity?.email ?? "";

  const sorted = [...team.notes].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  const openCreate = (): void => {
    setTitle("");
    setContent("");
    setTags("");
    setError(null);
    setPendingId(newId("note"));
    setEditing(true);
  };

  const openEdit = (note: TeamNote): void => {
    setTitle(note.title);
    setContent(note.content);
    setTags(note.tags.join(", "));
    setError(null);
    setPendingId(note.id);
    setEditing(true);
  };

  const handleSave = async (): Promise<void> => {
    if (!title.trim()) {
      setError(t("team.notes.errorTitle", { defaultValue: "请输入标题" }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const now = nowIso();
      const record: TeamNote = detail
        ? {
            ...detail,
            title: title.trim(),
            content,
            tags: splitTags(tags),
            updatedAt: now,
          }
        : {
            id: pendingId || newId("note"),
            title: title.trim(),
            content,
            authorEmail: myEmail,
            tags: splitTags(tags),
            createdAt: now,
            updatedAt: now,
          };
      await team.publish("note", record.id, record);
      setEditing(false);
      setDetail(record);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteNote = async (note: TeamNote): Promise<void> => {
    setDeleting(true);
    try {
      await team.remove("note", note.id);
      if (detail?.id === note.id) {
        setDetail(null);
      }
    } catch {
      // 删除失败静默
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="team-tasks">
      <div className="team-tab-toolbar">
        <span className="team-tab-title">
          {t("team.notes.title", { defaultValue: "知识沉淀" })}
          {sorted.length > 0 ? (
            <span
              className="team-task-group-count"
              title={t("team.notes.skillHint", {
                defaultValue:
                  "团队知识已自动沉淀为项目级 Skills（team-knowledge），AI 会话可自动使用",
              })}
            >
              <Sparkles size={11} />
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="team-btn team-btn-primary"
          onClick={openCreate}
        >
          <Plus size={15} />
          {t("team.notes.new", { defaultValue: "新建知识" })}
        </button>
      </div>

      {sorted.length === 0 ? (
        <TeamEmpty
          icon={<BookOpen size={28} strokeWidth={1.4} />}
          text={t("team.notes.empty", {
            defaultValue:
              "还没有共享知识。把团队的技术决策、踩坑记录沉淀到这里。",
          })}
        />
      ) : (
        <div className="team-note-grid">
          {sorted.map((note) => (
            <button
              type="button"
              key={note.id}
              className="team-note-card"
              onClick={() => setDetail(note)}
            >
              <div className="team-note-card-title">{note.title}</div>
              <div className="team-note-card-snippet">
                {note.content
                  ? isImageOnlyNote(note.content)
                    ? t("team.notes.imageOnly", {
                        defaultValue: "[图片]",
                      })
                    : mdToPlain(note.content)
                  : t("team.notes.noContent", { defaultValue: "（无内容）" })}
              </div>
              <div className="team-note-card-meta">
                <TeamMemberChip
                  members={team.members}
                  email={note.authorEmail}
                  size={20}
                />
                <span className="team-feed-time">
                  {timeAgo(note.updatedAt)}
                </span>
              </div>
              {note.tags.length > 0 ? (
                <div className="team-task-labels">
                  {note.tags.map((tag) => (
                    <span key={tag} className="team-label">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </button>
          ))}
        </div>
      )}

      <Modal
        open={editing}
        title={
          detail
            ? t("team.notes.edit", { defaultValue: "编辑知识" })
            : t("team.notes.new", { defaultValue: "新建知识" })
        }
        closeLabel={t("common.close", { defaultValue: "关闭" })}
        onClose={() => setEditing(false)}
        size="large"
        className="team-note-modal"
        footer={
          <>
            {error ? <span className="team-form-error">{error}</span> : null}
            <button
              type="button"
              className="team-btn team-btn-primary"
              disabled={busy}
              onClick={() => void handleSave()}
            >
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Save size={15} />
              )}
              {t("team.notes.save", { defaultValue: "保存" })}
            </button>
          </>
        }
      >
        <div className="team-form">
          <label className="team-form-label">
            {t("team.notes.titleField", { defaultValue: "标题" })}
            <input
              className="team-form-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </label>
          <div className="team-form-label team-form-label-grow">
            {t("team.notes.content", { defaultValue: "内容" })}
            <TeamMarkdownEditor
              value={content}
              onChange={setContent}
              repoPath={team.repoPath}
              noteId={pendingId}
              placeholder={t("team.notes.mdPlaceholder", {
                defaultValue:
                  "支持 Markdown 语法（**加粗**、`代码`、- 列表等），可直接粘贴或拖入图片…",
              })}
            />
          </div>
          <label className="team-form-label">
            {t("team.notes.tags", { defaultValue: "标签（逗号分隔）" })}
            <input
              className="team-form-input"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
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
                disabled={deleting}
                onClick={() => openEdit(detail)}
              >
                {t("team.notes.edit", { defaultValue: "编辑" })}
              </button>
              <button
                type="button"
                className="team-btn team-btn-danger"
                disabled={deleting}
                onClick={() => void deleteNote(detail)}
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
                email={detail.authorEmail}
                currentEmail={myEmail}
              />
              <span className="team-detail-meta-item">
                {formatTime(detail.updatedAt)}
              </span>
            </div>
            {detail.tags.length > 0 ? (
              <div className="team-task-labels">
                {detail.tags.map((tag) => (
                  <span key={tag} className="team-label">
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="team-note-markdown">
              {detail.content ? (
                <TeamNoteMarkdown
                  className="context-compaction-markdown"
                  content={detail.content}
                  repoPath={team.repoPath}
                />
              ) : (
                <div className="team-detail-note-content">
                  {t("team.notes.noContent", { defaultValue: "（无内容）" })}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
};

// 供页签图标复用
export const TeamNotesIcon = BookOpen;
