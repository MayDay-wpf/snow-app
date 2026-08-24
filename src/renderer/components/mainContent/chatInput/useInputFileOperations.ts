import { File, Folder } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import { useI18n } from "../../../i18n";
import {
  INSERT_ELEMENT_TAG_EVENT,
  buildTextSnippetSummary,
  createChipHtml,
  createElementChipHtml,
  createImageChipHtml,
  createTextSnippetChipHtml,
  createWebTagChipHtml,
  insertHtmlAtSelection,
  isEditableContentEmpty,
  readEditableContent,
  renumberImageChips as renumberImageChipsFn,
  type ElementTag,
  type FileTag,
  type ImageTag,
  type TextSnippetTag,
  type WebTag,
} from "./fileTagUtils";
import { TEXT_SNIPPET_THRESHOLD } from "./constants";
import { type PlusMenuSection } from "./PlusMenu";
import {
  TERMINAL_INSERT_TEXT_EVENT,
  type TerminalInsertTextPayload,
} from "../../rightPanel/terminal/terminalMonitor";
import {
  WEB_SNAPSHOT_REQUEST_EVENT,
  WEB_SNAPSHOT_RESULT_EVENT,
  WEB_SNAPSHOT_TIMEOUT_MS,
  nextSnapshotRequestId,
  type WebSnapshotRequest,
  type WebSnapshotResult,
} from "../../rightPanel/browserSnapshotEvents";

type UseInputFileOperationsOptions = {
  textareaRef: RefObject<HTMLDivElement | null>;
  handleChange: (content: string) => void;
};

type WebTagInsertOptions = {
  instanceId?: string;
  tabId?: string;
};

export type InputFileOperationsResult = {
  syncContent: () => void;
  insertFileTag: (tag: FileTag) => void;
  insertFileTags: (tags: FileTag[]) => void;
  insertElementTag: (tag: ElementTag) => void;
  insertImageFromFile: (file: File) => void;
  insertImageFiles: (files: File[]) => void;
  insertExternalFiles: (files: File[]) => void;
  insertDroppedPlainText: (text: string) => void;
  insertWebTag: (tag: WebTag, options?: WebTagInsertOptions) => void;
  handleSelectFiles: () => Promise<void>;
  handleSelectFolders: () => Promise<void>;
  plusMenuSections: PlusMenuSection[];
};

const findWebChipByUrl = (
  root: HTMLElement,
  url: string,
  title?: string,
): HTMLElement | null => {
  const chips = root.querySelectorAll<HTMLElement>("[data-web-tag='true']");
  let fallback: HTMLElement | null = null;
  let exact: HTMLElement | null = null;
  for (const chip of chips) {
    try {
      const data = JSON.parse(chip.dataset.webData || "{}") as Partial<WebTag>;
      if (data.url !== url) {
        continue;
      }
      fallback = chip;
      if (title && data.title === title) {
        exact = chip;
      }
    } catch {
      // Ignore malformed chip data
    }
  }
  return exact ?? fallback;
};

export const useInputFileOperations = ({
  textareaRef,
  handleChange,
}: UseInputFileOperationsOptions): InputFileOperationsResult => {
  const { t } = useI18n();
  const pendingWebSnapshotRef = useRef<
    Map<number, { url: string; title?: string }>
  >(new Map());
  // 记住编辑区最后一次有效光标位置：焦点被浏览器元素选择器/终端等
  // 外部交互夺走后，外部事件插入 chip 前需还原到此位置，否则
  // focus() 会把光标钉在行首，chip 永远插到输入框开头。
  const lastCaretRangeRef = useRef<Range | null>(null);

  useEffect(() => {
    const updateLastCaret = (): void => {
      const el = textareaRef.current;
      const selection = window.getSelection();
      if (!el || !selection || selection.rangeCount === 0) {
        return;
      }
      const range = selection.getRangeAt(0);
      if (el.contains(range.commonAncestorContainer)) {
        lastCaretRangeRef.current = range.cloneRange();
      }
    };
    document.addEventListener("selectionchange", updateLastCaret);
    return () =>
      document.removeEventListener("selectionchange", updateLastCaret);
  }, [textareaRef]);

  // 外部插入前优先还原最后记住的光标。不能先看当前选区再决定是否
  // 还原：focus() 后 Chromium 会在行首新建一个光标，该"新"选区也
  // 在编辑区内，若据此早退就会退回行首插入的老毛病。
  // selectionchange 会实时同步 saved range，因此直接覆盖是安全的。
  const restoreCaret = useCallback((): void => {
    const selection = window.getSelection();
    const saved = lastCaretRangeRef.current;
    if (!selection || !saved) {
      return;
    }
    if (!saved.startContainer.isConnected || !saved.endContainer.isConnected) {
      return;
    }
    selection.removeAllRanges();
    selection.addRange(saved);
  }, []);

  const renumberImageChips = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      renumberImageChipsFn(el);
    }
  }, [textareaRef]);

  const syncContent = useCallback(() => {
    if (textareaRef.current) {
      renumberImageChips();
      const content = readEditableContent(textareaRef.current);
      handleChange(content);
      textareaRef.current.dataset.empty = isEditableContentEmpty(content)
        ? "true"
        : "false";
    }
  }, [handleChange, renumberImageChips, textareaRef]);

  const insertFileTag = useCallback(
    (tag: FileTag) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      insertHtmlAtSelection(createChipHtml(tag));
      syncContent();
    },
    [syncContent, textareaRef],
  );

  const insertFileTags = useCallback(
    (tags: FileTag[]) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      insertHtmlAtSelection(tags.map((tag) => createChipHtml(tag)).join(" "));
      syncContent();
    },
    [syncContent, textareaRef],
  );

  const insertElementTag = useCallback(
    (tag: ElementTag) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        restoreCaret();
      }
      insertHtmlAtSelection(createElementChipHtml(tag));
      syncContent();
    },
    [restoreCaret, syncContent, textareaRef],
  );

  useEffect(() => {
    const onInsertText = (event: Event): void => {
      const detail = (event as CustomEvent<TerminalInsertTextPayload>).detail;
      if (!detail?.text || !textareaRef.current) {
        return;
      }
      textareaRef.current.focus();
      restoreCaret();
      const tag: TextSnippetTag = {
        content: detail.text,
        summary: buildTextSnippetSummary(detail.text, 36),
        charCount: detail.text.length,
      };
      insertHtmlAtSelection(createTextSnippetChipHtml(tag));
      syncContent();
    };
    window.addEventListener(TERMINAL_INSERT_TEXT_EVENT, onInsertText);
    return () =>
      window.removeEventListener(TERMINAL_INSERT_TEXT_EVENT, onInsertText);
  }, [restoreCaret, syncContent, textareaRef]);

  useEffect(() => {
    const handleInsertElementTag = (event: Event): void => {
      const tag = (event as CustomEvent<ElementTag>).detail;
      if (tag) {
        insertElementTag(tag);
      }
    };
    window.addEventListener(INSERT_ELEMENT_TAG_EVENT, handleInsertElementTag);
    return () => {
      window.removeEventListener(
        INSERT_ELEMENT_TAG_EVENT,
        handleInsertElementTag,
      );
    };
  }, [insertElementTag]);

  useEffect(() => {
    return window.snow.onElementTagInserted((tag) => {
      insertElementTag({
        url: tag.url,
        tag: tag.tag,
        label: tag.label,
        text: tag.text,
        note: tag.note,
      });
    });
  }, [insertElementTag]);

  useEffect(() => {
    const handleSnapshotResult = (event: Event): void => {
      const detail = (event as CustomEvent<WebSnapshotResult>).detail;
      if (!detail || typeof detail.requestId !== "number") {
        return;
      }
      const pending = pendingWebSnapshotRef.current.get(detail.requestId);
      if (!pending) {
        return;
      }
      pendingWebSnapshotRef.current.delete(detail.requestId);
      const snapshot = detail.snapshot;
      if (!snapshot) {
        return;
      }
      const el = textareaRef.current;
      if (!el) {
        return;
      }
      const webChip = findWebChipByUrl(el, pending.url, pending.title);
      if (!webChip) {
        return;
      }
      try {
        const prev = JSON.parse(
          webChip.dataset.webData || "{}",
        ) as Partial<WebTag>;
        webChip.dataset.webData = JSON.stringify({
          url: typeof prev.url === "string" ? prev.url : pending.url,
          title: typeof prev.title === "string" ? prev.title : pending.title,
          text: snapshot.text || undefined,
          elementText: snapshot.elementText,
          elementSelector: snapshot.elementSelector,
        });
      } catch {
        // Ignore malformed chip data
      }
      if (snapshot.screenshotDataUrl) {
        const imageTag: ImageTag = {
          name: "page-snapshot.png",
          dataUrl: snapshot.screenshotDataUrl,
        };
        webChip.insertAdjacentHTML("afterend", createImageChipHtml(imageTag));
        const inserted = webChip.nextElementSibling;
        if (inserted) {
          inserted.after(document.createTextNode(" "));
        }
      }
      syncContent();
    };
    window.addEventListener(WEB_SNAPSHOT_RESULT_EVENT, handleSnapshotResult);
    return () => {
      window.removeEventListener(
        WEB_SNAPSHOT_RESULT_EVENT,
        handleSnapshotResult,
      );
    };
  }, [syncContent, textareaRef]);

  const insertImageFromFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        if (!dataUrl) {
          return;
        }
        const mimeMatch = file.type.match(/^image\/([a-z]+)$/);
        const imageTag: ImageTag = {
          name: `image.${mimeMatch ? mimeMatch[1] : "png"}`,
          dataUrl,
        };
        if (textareaRef.current) {
          textareaRef.current.focus();
        }
        insertHtmlAtSelection(createImageChipHtml(imageTag));
        syncContent();
      };
      reader.readAsDataURL(file);
    },
    [syncContent, textareaRef],
  );

  const insertExternalFiles = useCallback(
    (files: File[]) => {
      if (!files || files.length === 0) {
        return;
      }
      void window.snow
        .resolveDroppedFiles(files)
        .then((entries) => {
          if (entries.length === 0) {
            return;
          }
          const imageFiles: File[] = [];
          const fileTags: FileTag[] = [];
          entries.forEach((entry, idx) => {
            const matchedFile = files[idx];
            const isImage =
              !entry.isDirectory &&
              ((matchedFile && matchedFile.type.startsWith("image/")) ||
                /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(entry.path));
            if (isImage && matchedFile) {
              imageFiles.push(matchedFile);
            } else {
              const name =
                entry.path.split(/[\\/]/).filter(Boolean).pop() || entry.path;
              fileTags.push({
                path: entry.path,
                name,
                isDirectory: entry.isDirectory,
              });
            }
          });
          for (const imageFile of imageFiles) {
            insertImageFromFile(imageFile);
          }
          if (fileTags.length > 0) {
            insertFileTags(fileTags);
          }
        })
        .catch(() => {
          // Ignore path resolution failures
        });
    },
    [insertFileTags, insertImageFromFile],
  );

  const insertImageFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      for (const file of files) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          if (!dataUrl) {
            return;
          }
          const mimeMatch = file.type.match(/^image\/([a-z]+)$/);
          const imageTag: ImageTag = {
            name: `image.${mimeMatch ? mimeMatch[1] : "png"}`,
            dataUrl,
          };
          insertHtmlAtSelection(createImageChipHtml(imageTag));
          syncContent();
        };
        reader.readAsDataURL(file);
      }
    },
    [syncContent, textareaRef],
  );

  const insertDroppedPlainText = useCallback(
    (text: string) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      if (text.length > TEXT_SNIPPET_THRESHOLD) {
        const tag: TextSnippetTag = {
          content: text,
          summary: buildTextSnippetSummary(text),
          charCount: text.length,
        };
        insertHtmlAtSelection(createTextSnippetChipHtml(tag));
        syncContent();
        return;
      }
      document.execCommand("insertText", false, text);
      syncContent();
    },
    [syncContent, textareaRef],
  );

  const insertWebTag = useCallback(
    (tag: WebTag, options?: WebTagInsertOptions) => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      insertHtmlAtSelection(createWebTagChipHtml(tag));
      syncContent();
      if (!options?.instanceId) {
        return;
      }
      const requestId = nextSnapshotRequestId();
      pendingWebSnapshotRef.current.set(requestId, {
        url: tag.url,
        title: tag.title,
      });
      window.setTimeout(() => {
        pendingWebSnapshotRef.current.delete(requestId);
      }, WEB_SNAPSHOT_TIMEOUT_MS);
      window.dispatchEvent(
        new CustomEvent<WebSnapshotRequest>(WEB_SNAPSHOT_REQUEST_EVENT, {
          detail: {
            requestId,
            instanceId: options.instanceId,
            tabId: options.tabId ?? "",
            url: tag.url,
          },
        }),
      );
    },
    [syncContent, textareaRef],
  );

  const handleSelectFiles = useCallback(async () => {
    try {
      const selected = await window.snow.selectFiles(
        t("plusMenu.selectFilesTitle"),
      );
      if (!selected || selected.length === 0) {
        return;
      }
      const tags: FileTag[] = selected.map((item) => {
        const path = item.path;
        const name = path.split("/").filter(Boolean).pop() || path;
        return { path, name, isDirectory: item.isDirectory };
      });
      insertFileTags(tags);
    } catch {
      // Dialog cancelled or failed
    }
  }, [insertFileTags, t]);

  const handleSelectFolders = useCallback(async () => {
    try {
      const selected = await window.snow.selectDirectories(
        t("plusMenu.selectFoldersTitle"),
      );
      if (!selected || selected.length === 0) {
        return;
      }
      const tags: FileTag[] = selected.map((item) => {
        const path = item.path;
        const name = path.split("/").filter(Boolean).pop() || path;
        return { path, name, isDirectory: item.isDirectory };
      });
      insertFileTags(tags);
    } catch {
      // Dialog cancelled or failed
    }
  }, [insertFileTags, t]);

  const plusMenuSections = useMemo<PlusMenuSection[]>(
    () => [
      {
        id: "add",
        label: t("plusMenu.sectionAdd"),
        items: [
          {
            id: "files",
            label: t("plusMenu.files"),
            icon: File,
            onSelect: () => void handleSelectFiles(),
          },
          {
            id: "folders",
            label: t("plusMenu.folders"),
            icon: Folder,
            onSelect: () => void handleSelectFolders(),
          },
        ],
      },
    ],
    [t, handleSelectFiles, handleSelectFolders],
  );

  return {
    syncContent,
    insertFileTag,
    insertFileTags,
    insertElementTag,
    insertImageFromFile,
    insertImageFiles,
    insertExternalFiles,
    insertDroppedPlainText,
    insertWebTag,
    handleSelectFiles,
    handleSelectFolders,
    plusMenuSections,
  };
};
