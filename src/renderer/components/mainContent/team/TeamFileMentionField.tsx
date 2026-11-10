import { X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { getFileTypeIcon } from "../../../utils/fileIcons";
import {
  FileMentionPopup,
  type FileMentionPopupHandle,
} from "../chatInput/FileMentionPopup";
import type { MentionTag } from "../chatInput/fileTagUtils";

/** 归一化为 "/" 分隔并去掉末尾斜杠。 */
const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/\/+$/, "");

/** 项目根内的绝对路径转相对路径；根外路径原样保留。 */
const toRelativePath = (absolutePath: string, rootPath: string): string => {
  const root = normalizePath(rootPath);
  const target = normalizePath(absolutePath);
  if (!root) {
    return target;
  }
  const lowerRoot = root.toLowerCase();
  const lowerTarget = target.toLowerCase();
  if (lowerTarget === lowerRoot) {
    return "";
  }
  if (lowerTarget.startsWith(`${lowerRoot}/`)) {
    return target.slice(root.length + 1);
  }
  return target;
};

export type TeamFileMentionFieldProps = {
  /** 已选文件（相对项目根的路径）。 */
  value: string[];
  onChange: (next: string[]) => void;
  directoryId: string;
  /** 当前项目根目录的绝对路径，用于把选中文件转成相对路径。 */
  directoryPath: string;
  placeholder?: string;
};

/**
 * 关联文件输入：键入 @ 唤起文件检索（复用聊天输入的文件提及面板），
 * 选中后以文件标签展示，仅保存相对项目根的路径。
 */
export const TeamFileMentionField = ({
  value,
  onChange,
  directoryId,
  directoryPath,
  placeholder,
}: TeamFileMentionFieldProps): React.JSX.Element => {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<FileMentionPopupHandle | null>(null);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(false);
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({
    visibility: "hidden",
  });
  // `@` 之后第一个字符在输入框中的位置
  const mentionStartRef = useRef(-1);

  const closePopup = useCallback(() => {
    setVisible(false);
    setQuery("");
    mentionStartRef.current = -1;
  }, []);

  /** 面板跟随输入框：下方空间不足时向上展开。 */
  const positionPopup = useCallback(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    const rect = input.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 420), window.innerWidth - 24);
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - width - 12),
    );
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 320;
    const space = (openUp ? rect.top : spaceBelow) - 12;
    setPopupStyle({
      position: "fixed",
      top: openUp ? "auto" : `${rect.bottom + 6}px`,
      bottom: openUp ? `${window.innerHeight - rect.top + 6}px` : "auto",
      left: `${left}px`,
      right: "auto",
      width: `${width}px`,
      maxHeight: `${Math.max(160, Math.min(340, space))}px`,
      zIndex: 100000,
    });
  }, []);

  /** 根据光标前的 `@查询词` 同步面板；不在 @ 上下文时收起。 */
  const syncMention = useCallback(
    (nextText: string, caret: number) => {
      const before = nextText.slice(0, caret);
      const match = before.match(/(?:^|\s)@([^\s]*)$/);
      if (!match) {
        closePopup();
        return;
      }
      const queryText = match[1];
      mentionStartRef.current = caret - queryText.length;
      setQuery(queryText);
      setVisible(true);
      positionPopup();
    },
    [closePopup, positionPopup],
  );

  const addPaths = useCallback(
    (paths: string[]) => {
      const next = [...value];
      for (const path of paths) {
        if (path && !next.includes(path)) {
          next.push(path);
        }
      }
      if (next.length !== value.length) {
        onChange(next);
      }
    },
    [onChange, value],
  );

  const applySelection = useCallback(
    (tags: MentionTag[]) => {
      addPaths(
        tags
          .map((tag) =>
            "path" in tag ? toRelativePath(tag.path, directoryPath) : "",
          )
          .filter((path): path is string => Boolean(path)),
      );
      setText("");
      closePopup();
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [addPaths, closePopup, directoryPath],
  );

  /** 路径导航：把 `@` 后的查询替换为 `相对路径/` 后继续浏览。 */
  const handleNavigate = useCallback(
    (relativePath: string) => {
      const input = inputRef.current;
      const start = mentionStartRef.current;
      if (!input || start < 0) {
        return;
      }
      const caret = input.selectionStart ?? text.length;
      const insert = relativePath ? `${relativePath}/` : "";
      const nextText = text.slice(0, start) + insert + text.slice(caret);
      setText(nextText);
      setQuery(insert);
      setVisible(true);
      const nextCaret = start + insert.length;
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [text],
  );

  return (
    <div className="team-file-mention" ref={anchorRef}>
      <div className="team-file-mention-field">
        {value.map((path) => (
          <span key={path} className="file-chip" title={path}>
            <span className="file-chip-icon">
              {getFileTypeIcon(path, false, false, { size: 12 })}
            </span>
            <span className="file-chip-name">{path}</span>
            <button
              type="button"
              className="file-chip-remove"
              title={t("team.tasks.removeFile", { defaultValue: "移除文件" })}
              aria-label={t("team.tasks.removeFile", {
                defaultValue: "移除文件",
              })}
              onClick={() => onChange(value.filter((item) => item !== path))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="team-file-mention-input"
          value={text}
          placeholder={
            placeholder ??
            t("team.tasks.fileMentionPlaceholder", {
              defaultValue: "输入 @ 搜索并添加文件",
            })
          }
          spellCheck={false}
          onChange={(event) => {
            const nextText = event.target.value;
            setText(nextText);
            syncMention(
              nextText,
              event.target.selectionStart ?? nextText.length,
            );
          }}
          onClick={(event) =>
            syncMention(text, event.currentTarget.selectionStart ?? 0)
          }
          onKeyUp={(event) => {
            if (
              event.key.startsWith("Arrow") ||
              event.key === "Home" ||
              event.key === "End"
            ) {
              const input = event.currentTarget;
              syncMention(input.value, input.selectionStart ?? 0);
            }
          }}
          onKeyDown={(event) => {
            if (!visible) {
              return;
            }
            const handled = popupRef.current?.handleKeyDown(
              event as unknown as React.KeyboardEvent<HTMLDivElement>,
            );
            if (handled) {
              event.preventDefault();
            }
          }}
        />
      </div>
      <FileMentionPopup
        ref={popupRef}
        visible={visible}
        query={query}
        onClose={closePopup}
        onSelect={(tag) => applySelection([tag])}
        onSelectBatch={applySelection}
        textareaRef={anchorRef}
        onNavigateTo={handleNavigate}
        projectId={directoryId}
        style={popupStyle}
        portal
      />
    </div>
  );
};
