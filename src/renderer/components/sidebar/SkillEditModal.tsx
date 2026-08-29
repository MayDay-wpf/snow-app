import {
  AlertCircle,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DirectoryEntry, SkillDefinition } from "../../../preload";
import { useI18n } from "../../i18n";
import { Modal } from "../common/Modal";
import { FileViewerContent } from "../rightPanel/FileViewerContent";

type SkillEditModalProps = {
  skill: SkillDefinition;
  onClose: () => void;
};

const fileNameOf = (path: string): string => {
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSep === -1 ? path : path.slice(lastSep + 1);
};

const sortEntries = (entries: DirectoryEntry[]): DirectoryEntry[] =>
  [...entries].sort((a, b) =>
    a.isDirectory === b.isDirectory
      ? a.name.localeCompare(b.name)
      : a.isDirectory
        ? -1
        : 1,
  );

/**
 * Skill 编辑弹窗：左侧展示 Skill 目录的文件结构（目录懒加载、可展开折叠），
 * 右侧复用右侧面板的 FileViewerContent，选中文件后自动进入编辑模式。
 */
export function SkillEditModal({
  skill,
  onClose,
}: SkillEditModalProps): React.JSX.Element {
  const { t } = useI18n();
  const [entriesByDir, setEntriesByDir] = useState<
    Record<string, DirectoryEntry[]>
  >({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const loadDir = useCallback(
    async (dirPath: string): Promise<DirectoryEntry[] | null> => {
      try {
        const sorted = sortEntries(
          await window.snow.readDirectoryEntries(dirPath),
        );
        setEntriesByDir((prev) =>
          prev[dirPath] ? prev : { ...prev, [dirPath]: sorted },
        );
        return sorted;
      } catch {
        return null;
      }
    },
    [],
  );

  // 打开弹窗时加载根目录并默认选中 SKILL.md（不存在则选首个文件）。
  useEffect(() => {
    let cancelled = false;
    setEntriesByDir({});
    setExpandedDirs(new Set());
    setLoadingDirs(new Set());
    setTreeError("");
    setSelectedFile(null);
    setDirty(false);
    setLoadingDirs(new Set([skill.path]));

    void (async () => {
      const entries = await loadDir(skill.path);
      if (cancelled) return;
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(skill.path);
        return next;
      });
      if (!entries) {
        setTreeError(
          t("settings.skillsEditTreeError", {
            defaultValue: "Failed to load files",
          }),
        );
        return;
      }
      const files = entries.filter((entry) => !entry.isDirectory);
      const preferred = files.find((entry) => /skill\.md$/i.test(entry.name));
      if (preferred) {
        setSelectedFile(preferred.path);
      } else if (files.length > 0) {
        setSelectedFile(files[0].path);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadDir, skill.path, t]);

  const toggleDir = useCallback(
    async (entry: DirectoryEntry): Promise<void> => {
      const willExpand = !expandedDirs.has(entry.path);
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (willExpand) {
          next.add(entry.path);
        } else {
          next.delete(entry.path);
        }
        return next;
      });
      if (
        willExpand &&
        !entriesByDir[entry.path] &&
        !loadingDirs.has(entry.path)
      ) {
        setLoadingDirs((prev) => new Set(prev).add(entry.path));
        await loadDir(entry.path);
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(entry.path);
          return next;
        });
      }
    },
    [entriesByDir, expandedDirs, loadingDirs, loadDir],
  );

  const discardConfirm = useCallback((): boolean => {
    if (!dirty) {
      return true;
    }
    return window.confirm(
      t("settings.skillsEditDiscardConfirm", {
        defaultValue: "You have unsaved changes. Discard and close?",
      }),
    );
  }, [dirty, t]);

  const handleClose = useCallback(() => {
    if (!discardConfirm()) {
      return;
    }
    onClose();
  }, [discardConfirm, onClose]);

  const selectFile = useCallback(
    (path: string): void => {
      if (path === selectedFile) {
        return;
      }
      if (!discardConfirm()) {
        return;
      }
      setSelectedFile(path);
    },
    [discardConfirm, selectedFile],
  );

  const renderEntries = useCallback(
    (dirPath: string, depth: number): React.JSX.Element | null => {
      if (loadingDirs.has(dirPath)) {
        return (
          <div
            className="skill-edit-tree-row loading"
            style={{ paddingLeft: 10 + depth * 14 }}
          >
            <Loader2 size={13} className="spin" />
          </div>
        );
      }
      const entries = entriesByDir[dirPath];
      if (!entries) {
        return null;
      }
      return (
        <>
          {entries.map((entry) => {
            const isExpanded = expandedDirs.has(entry.path);
            const indent = 10 + depth * 14;
            if (entry.isDirectory) {
              return (
                <div key={entry.path}>
                  <button
                    className="skill-edit-tree-row"
                    style={{ paddingLeft: indent }}
                    type="button"
                    onClick={() => void toggleDir(entry)}
                  >
                    <ChevronRight
                      size={12}
                      className={`skill-edit-tree-chevron${
                        isExpanded ? " expanded" : ""
                      }`}
                    />
                    <Folder size={13} className="skill-edit-tree-folder" />
                    <span className="skill-edit-tree-name">{entry.name}</span>
                  </button>
                  {isExpanded ? renderEntries(entry.path, depth + 1) : null}
                </div>
              );
            }
            const isActive = selectedFile === entry.path;
            return (
              <button
                className={`skill-edit-tree-row${isActive ? " active" : ""}`}
                key={entry.path}
                style={{ paddingLeft: indent + 14 }}
                type="button"
                onClick={() => selectFile(entry.path)}
                title={entry.path}
              >
                <FileText size={13} className="skill-edit-tree-file" />
                <span className="skill-edit-tree-name">{entry.name}</span>
              </button>
            );
          })}
        </>
      );
    },
    [
      entriesByDir,
      expandedDirs,
      loadingDirs,
      selectedFile,
      selectFile,
      toggleDir,
    ],
  );

  return (
    <Modal
      open
      title={skill.name}
      description={skill.path}
      closeLabel={t("common.close", { defaultValue: "Close" })}
      onClose={handleClose}
      size="large"
      className="skill-edit-modal"
    >
      <div className="skill-edit-modal-layout">
        <aside className="skill-edit-tree-pane">
          <div className="skill-edit-tree-pane-header">
            {t("settings.skillsEditFiles", { defaultValue: "Files" })}
          </div>
          <div className="skill-edit-tree">
            {treeError ? (
              <div className="skill-edit-tree-status">
                <AlertCircle size={14} />
                <span>{treeError}</span>
              </div>
            ) : (
              renderEntries(skill.path, 0)
            )}
            {!treeError &&
              entriesByDir[skill.path] &&
              entriesByDir[skill.path].length === 0 && (
                <div className="skill-edit-tree-status">
                  <FileText size={14} />
                  <span>
                    {t("settings.skillsEditEmpty", {
                      defaultValue: "No files found",
                    })}
                  </span>
                </div>
              )}
          </div>
        </aside>
        <div className="skill-edit-viewer-pane">
          {selectedFile ? (
            <FileViewerContent
              key={selectedFile}
              filePath={selectedFile}
              fileName={fileNameOf(selectedFile)}
              isSsh={false}
              initialEditMode
              onDirtyChange={setDirty}
            />
          ) : (
            <div className="skill-edit-viewer-empty">
              <FileText size={20} />
              <span>
                {t("settings.skillsEditSelectFile", {
                  defaultValue: "Select a file to edit",
                })}
              </span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
