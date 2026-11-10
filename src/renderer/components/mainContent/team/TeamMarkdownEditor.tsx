import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  Link,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { tGlobal, useI18n } from "../../../i18n";
import { MarkdownBlock } from "../chatMessages/components/markdownRenderer";
import { TeamErrorNotice } from "./TeamShared";
import { MEDIA_REF_PREFIX, resolveMediaRefs } from "./teamUtils";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 单行图片语法：内嵌 data URL 或团队附件引用 `team-media:<附件 id>`。 */
const IMAGE_TAG = /^!\[[^\]]*\]\((?:data:image\/[^)]+|team-media:[^)\s]+)\)$/;

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("read failed"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });

/** 从 mime 推断落盘扩展名（jpeg 归一为 jpg），未知回退 png。 */
const extForMime = (mime: string): string => {
  const ext = mime.split("/")[1] ?? "";
  if (ext === "jpeg") return "jpg";
  return /^(png|webp|gif|bmp)$/.test(ext) ? ext : "png";
};

/**
 * 笔记正文附件解析：把正文里的 `team-media:<附件 id>` 引用替换为 data URL，
 * 已解析的附件按 id 缓存，避免重复读库；正文变化后尚未解析完成时先渲染原文。
 */
const useResolvedMediaContent = (
  content: string,
  readMedia: (mediaId: string) => Promise<string>,
): string => {
  const cacheRef = useRef(new Map<string, string>());
  const [resolved, setResolved] = useState({ source: content, text: content });

  useEffect(() => {
    let cancelled = false;
    const read = async (mediaId: string): Promise<string> => {
      const cached = cacheRef.current.get(mediaId);
      if (cached) {
        return cached;
      }
      const url = await readMedia(mediaId);
      cacheRef.current.set(mediaId, url);
      return url;
    };
    void resolveMediaRefs(content, read).then((text) => {
      if (!cancelled) {
        setResolved({ source: content, text });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [content, readMedia]);

  return resolved.source === content ? resolved.text : content;
};

type TeamMarkdownEditorProps = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** 当前笔记 id，作为图片附件的归属记录；为空时图片退化为 data URL 内嵌。 */
  noteId: string;
  /** 保存图片附件，返回附件 id。 */
  saveMedia: (
    ownerId: string,
    fileName: string,
    base64: string,
    imageOnly: boolean,
  ) => Promise<string>;
  /** 读取附件内容为 data URL。 */
  readMedia: (mediaId: string) => Promise<string>;
};

export const TeamMarkdownEditor = ({
  value,
  onChange,
  placeholder,
  noteId,
  saveMedia,
  readMedia,
}: TeamMarkdownEditorProps): React.JSX.Element => {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);
  const previewContent = useResolvedMediaContent(value, readMedia);

  const insertText = (text: string): void => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const next = value.slice(0, s) + text + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = s + text.length;
      el.setSelectionRange(cursor, cursor);
    });
  };

  const insertImage = async (file: File): Promise<void> => {
    const dataUrl = await fileToDataUrl(file);
    let src = dataUrl;
    if (noteId) {
      try {
        const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extForMime(file.type)}`;
        const mediaId = await saveMedia(noteId, fileName, dataUrl, true);
        src = `${MEDIA_REF_PREFIX}${mediaId}`;
      } catch {
        setError(
          t("team.notes.imageSaveFailed", {
            defaultValue: "图片保存失败，已内嵌插入",
          }),
        );
      }
    }
    insertText(`![image](${src})`);
  };

  const handlePastedFiles = async (files: File[]): Promise<void> => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        setError(
          t("team.notes.imageTooLarge", {
            values: { size: "5MB" },
            defaultValue: "图片超过 5MB，无法插入",
          }),
        );
        continue;
      }
      try {
        await insertImage(file);
      } catch {
        setError(
          t("team.notes.imageReadFailed", {
            defaultValue: "图片读取失败",
          }),
        );
      }
    }
  };

  const handlePaste = (
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ): void => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return;
    event.preventDefault();
    void handlePastedFiles(files);
  };

  const handleDrop = (event: React.DragEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    void handlePastedFiles(images);
  };

  const handlePickImage = (): void => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length > 0) {
      void handlePastedFiles(files);
    }
  };

  /** 选中文本包裹：有选区包选区，无选区插入占位符并选中。 */
  const applyWrap = (
    before: string,
    after: string,
    placeholderText: string,
  ): void => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const selected = value.slice(s, e);
    const insert = selected
      ? before + selected + after
      : before + placeholderText + after;
    const next = value.slice(0, s) + insert + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const start = selected ? s : s + before.length;
      const end = selected ? s + insert.length : start + placeholderText.length;
      el.setSelectionRange(start, end);
    });
  };

  /** 行级语法：行首插入前缀，已有前缀则去除（toggle）。 */
  const applyBlock = (prefix: string): void => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const lineEndIdx = value.indexOf("\n", e);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const line = value.slice(lineStart, lineEnd);
    const nextLine = line.startsWith(prefix)
      ? line.slice(prefix.length)
      : prefix + line;
    const next = value.slice(0, lineStart) + nextLine + value.slice(lineEnd);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const start = lineStart + (line.startsWith(prefix) ? 0 : prefix.length);
      const end = start + (lineEnd - lineStart);
      el.setSelectionRange(start, end);
    });
  };

  const tools = [
    {
      icon: Bold,
      title: t("team.notes.mdBold", { defaultValue: "加粗" }),
      run: () => applyWrap("**", "**", t("team.md.boldText")),
    },
    {
      icon: Italic,
      title: t("team.notes.mdItalic", { defaultValue: "斜体" }),
      run: () => applyWrap("*", "*", t("team.md.italicText")),
    },
    {
      icon: Strikethrough,
      title: t("team.notes.mdStrike", { defaultValue: "删除线" }),
      run: () => applyWrap("~~", "~~", t("team.md.strikeText")),
    },
    {
      icon: Heading1,
      title: t("team.notes.mdH1", { defaultValue: "一级标题" }),
      run: () => applyBlock("# "),
    },
    {
      icon: Heading2,
      title: t("team.notes.mdH2", { defaultValue: "二级标题" }),
      run: () => applyBlock("## "),
    },
    {
      icon: Quote,
      title: t("team.notes.mdQuote", { defaultValue: "引用" }),
      run: () => applyBlock("> "),
    },
    {
      icon: List,
      title: t("team.notes.mdList", { defaultValue: "无序列表" }),
      run: () => applyBlock("- "),
    },
    {
      icon: ListOrdered,
      title: t("team.notes.mdOrderedList", { defaultValue: "有序列表" }),
      run: () => applyBlock("1. "),
    },
    {
      icon: Code2,
      title: t("team.notes.mdCode", { defaultValue: "代码块" }),
      run: () => applyWrap("```\n", "\n```", t("team.md.codeText")),
    },
    {
      icon: Link,
      title: t("team.notes.mdLink", { defaultValue: "链接" }),
      run: () => applyWrap("[", "](https://)", t("team.md.linkText")),
    },
    {
      icon: ImagePlus,
      title: t("team.notes.mdImage", { defaultValue: "插入图片" }),
      run: handlePickImage,
    },
  ];

  return (
    <div className="team-md-editor">
      <div className="team-md-toolbar">
        {tools.map(({ icon: Icon, title, run }) => (
          <button
            key={title}
            type="button"
            className="team-md-tool-btn"
            title={title}
            aria-label={title}
            onClick={(e) => {
              e.preventDefault();
              run();
            }}
          >
            <Icon size={14} strokeWidth={1.9} />
          </button>
        ))}
        <span className="team-md-toolbar-hint">
          {t("team.notes.mdPasteHint", {
            defaultValue: "支持 Ctrl+V 粘贴截图 / 拖入图片",
          })}
        </span>
        <TeamErrorNotice message={error} onDismiss={clearError} />
      </div>
      <div className="team-md-split">
        <textarea
          className="team-md-textarea"
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onPaste={handlePaste}
          onDrop={handleDrop}
        />
        <div className="team-md-preview">
          {value.trim() ? (
            <MarkdownBlock
              className="context-compaction-markdown"
              content={previewContent}
            />
          ) : (
            <div className="team-md-preview-empty">
              {t("team.notes.mdPreviewEmpty", {
                defaultValue: "预览区域",
              })}
            </div>
          )}
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
    </div>
  );
};

/**
 * 团队笔记 Markdown 渲染：把正文中的 `team-media:<附件 id>` 引用读成 data URL
 * 后再交给 MarkdownBlock，其余内容原样渲染。
 */
export const TeamNoteMarkdown = ({
  content,
  className,
  readMedia,
}: {
  content: string;
  className: string;
  readMedia: (mediaId: string) => Promise<string>;
}): React.JSX.Element => {
  const resolved = useResolvedMediaContent(content, readMedia);
  return <MarkdownBlock className={className} content={resolved} />;
};

// 供列表摘要等场景把 Markdown 源文本转为纯文本
export const mdToPlain = (md: string): string =>
  md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, tGlobal("team.md.plainImage"))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, tGlobal("team.md.plainCodeBlock"))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const isImageOnlyNote = (md: string): boolean =>
  md
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .every((line) => IMAGE_TAG.test(line));
