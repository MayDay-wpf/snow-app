import {
  AlertCircle,
  FileCode2,
  FolderOpen,
  Loader2,
  Save,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SshFileVersion,
  WorkspaceDirectoryRecord,
} from "../../../../preload";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { useI18n } from "../../../i18n";
import {
  buildRoleFilePath,
  buildRoleSettingsPath,
  buildSshConnectParams,
  readIncludeGlobalRules,
  writeIncludeGlobalRules,
  type ProjectDirectoryInfo,
} from "./roleFileUtils";

type ProjectRoleEditorProps = {
  /** 当前激活的工作区项目；为空时无法编辑项目规则。 */
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

/**
 * 项目规则编辑器：直接编辑当前激活项目根目录的 ROLE.md。
 * 与 MCP 项目作用域一致，项目层级只允许设置当前项目、不允许任意切换，
 * 避免规则设置出现与当前上下文无关的任意性。支持本地与 SSH 远程工作区。
 */
export const ProjectRoleEditor = ({
  activeDirectory,
}: ProjectRoleEditorProps): React.JSX.Element => {
  const { t } = useI18n();
  const [directoryInfo, setDirectoryInfo] =
    useState<ProjectDirectoryInfo | null>(null);
  const [roleFilePath, setRoleFilePath] = useState("");
  const [settingsFilePath, setSettingsFilePath] = useState("");
  const [settingsContent, setSettingsContent] = useState("");
  const [includeGlobalRules, setIncludeGlobalRules] = useState(true);
  const [originalIncludeGlobalRules, setOriginalIncludeGlobalRules] =
    useState(true);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const loadGenerationRef = useRef(0);
  const sshSessionIdRef = useRef<string | null>(null);
  const remoteRoleVersionRef = useRef<SshFileVersion>({ exists: false });
  const remoteSettingsVersionRef = useRef<SshFileVersion>({ exists: false });

  // 断开 SSH 会话（切换项目/卸载时）。
  const disconnectSsh = useCallback((): void => {
    if (sshSessionIdRef.current) {
      void window.snow.sshDisconnect(sshSessionIdRef.current);
      sshSessionIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      disconnectSsh();
    };
  }, [disconnectSsh]);

  // 重置编辑器状态：使任何在途请求失效、清空草稿并断开 SSH 会话。
  const resetEditor = useCallback((): void => {
    loadGenerationRef.current += 1;
    setIsLoading(false);
    setError(null);
    setSaveSuccess(false);
    setContent("");
    setOriginalContent("");
    setDirectoryInfo(null);
    setRoleFilePath("");
    setSettingsFilePath("");
    setSettingsContent("");
    setIncludeGlobalRules(true);
    setOriginalIncludeGlobalRules(true);
    remoteRoleVersionRef.current = { exists: false };
    remoteSettingsVersionRef.current = { exists: false };
    disconnectSsh();
  }, [disconnectSsh]);

  const loadProjectRole = useCallback(
    async (info: ProjectDirectoryInfo): Promise<void> => {
      resetEditor();
      setIsLoading(true);
      const generation = loadGenerationRef.current;

      try {
        setDirectoryInfo(info);
        const filePath = buildRoleFilePath(info);
        const projectSettingsPath = buildRoleSettingsPath(info);
        setRoleFilePath(filePath);
        setSettingsFilePath(projectSettingsPath);

        if (info.isSsh) {
          const connectParams = await buildSshConnectParams(info.path);
          if (loadGenerationRef.current !== generation) return;
          if (!connectParams) {
            setError(
              t("roleEditor.sshCredentialMissing", {
                defaultValue:
                  "SSH credential is missing. Please configure it in the project settings.",
              })
            );
            return;
          }

          const sessionId = await window.snow.sshConnect(connectParams);
          if (loadGenerationRef.current !== generation) {
            void window.snow.sshDisconnect(sessionId);
            return;
          }
          sshSessionIdRef.current = sessionId;

          try {
            const result = await window.snow.sshReadFile(sessionId, filePath);
            if (loadGenerationRef.current !== generation) return;
            const text = result.isBinary ? "" : result.content;
            setContent(text);
            setOriginalContent(text);
            remoteRoleVersionRef.current = result.remoteVersion ?? { exists: false };
          } catch (readError) {
            if (loadGenerationRef.current !== generation) return;
            // File does not exist yet — start with empty content.
            setContent("");
            setOriginalContent("");
            remoteRoleVersionRef.current = { exists: false };
          }
          try {
            const result = await window.snow.sshReadFile(
              sessionId,
              projectSettingsPath
            );
            if (loadGenerationRef.current !== generation) return;
            const text = result.isBinary ? "" : result.content;
            const enabled = readIncludeGlobalRules(text);
            setSettingsContent(text);
            setIncludeGlobalRules(enabled);
            setOriginalIncludeGlobalRules(enabled);
            remoteSettingsVersionRef.current = result.remoteVersion ?? {
              exists: false,
            };
          } catch {
            setSettingsContent("");
            remoteSettingsVersionRef.current = { exists: false };
          }
        } else {
          try {
            const result = await window.snow.readFileContent(filePath);
            if (loadGenerationRef.current !== generation) return;
            const text = result.isBinary ? "" : result.content;
            setContent(text);
            setOriginalContent(text);
          } catch (readError) {
            if (loadGenerationRef.current !== generation) return;
            // File does not exist yet — start with empty content.
            setContent("");
            setOriginalContent("");
          }
          try {
            const result = await window.snow.readFileContent(
              projectSettingsPath
            );
            if (loadGenerationRef.current !== generation) return;
            const text = result.isBinary ? "" : result.content;
            const enabled = readIncludeGlobalRules(text);
            setSettingsContent(text);
            setIncludeGlobalRules(enabled);
            setOriginalIncludeGlobalRules(enabled);
          } catch {
            setSettingsContent("");
          }
        }
      } catch (loadError) {
        if (loadGenerationRef.current !== generation) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        );
      } finally {
        if (loadGenerationRef.current === generation) {
          setIsLoading(false);
        }
      }
    },
    [resetEditor, t]
  );

  // 跟随当前激活项目：项目切换时重新加载对应 ROLE.md，无项目时清空编辑器。
  useEffect(() => {
    if (!activeDirectory) {
      resetEditor();
      return;
    }
    void loadProjectRole({
      path: activeDirectory.path,
      isSsh: activeDirectory.path.startsWith("ssh://"),
    });
  }, [activeDirectory, loadProjectRole, resetEditor]);

  const handleSave = async (): Promise<void> => {
    if (!directoryInfo || !roleFilePath || !settingsFilePath || isSaving) return;

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      if (directoryInfo.isSsh) {
        if (!activeDirectory?.directoryId) {
          throw new Error("Remote project rule save is missing its workspace ID");
        }
        if (!sshSessionIdRef.current) {
          const connectParams = await buildSshConnectParams(directoryInfo.path);
          if (!connectParams) {
            setError(
              t("roleEditor.sshCredentialMissing", {
                defaultValue:
                  "SSH credential is missing. Please configure it in the project settings.",
              })
            );
            setIsSaving(false);
            return;
          }
          sshSessionIdRef.current = await window.snow.sshConnect(connectParams);
        }
        const roleWrite = await window.snow.sshWriteFile(
          sshSessionIdRef.current,
          roleFilePath,
          content,
          {
            workspaceId: activeDirectory.directoryId,
            expectedVersion: remoteRoleVersionRef.current,
          }
        );
        remoteRoleVersionRef.current = roleWrite.version;
        if (includeGlobalRules !== originalIncludeGlobalRules) {
          const settingsDirectory = settingsFilePath.replace(/\/[^/]+$/, "");
          const quotedDirectory = `'${settingsDirectory.replace(/'/g, `'"'"'`)}'`;
          await window.snow.sshExecuteCommand(
            sshSessionIdRef.current,
            `mkdir -p -- ${quotedDirectory}`
          );
          const nextSettings = writeIncludeGlobalRules(
            settingsContent,
            includeGlobalRules
          );
          const settingsWrite = await window.snow.sshWriteFile(
            sshSessionIdRef.current,
            settingsFilePath,
            nextSettings,
            {
              workspaceId: activeDirectory.directoryId,
              expectedVersion: remoteSettingsVersionRef.current,
            }
          );
          remoteSettingsVersionRef.current = settingsWrite.version;
          setSettingsContent(nextSettings);
        }
      } else {
        await window.snow.writeFileContent(roleFilePath, content);
        if (includeGlobalRules !== originalIncludeGlobalRules) {
          const nextSettings = writeIncludeGlobalRules(
            settingsContent,
            includeGlobalRules
          );
          await window.snow.writeFileContent(settingsFilePath, nextSettings);
          setSettingsContent(nextSettings);
        }
      }

      setOriginalContent(content);
      setOriginalIncludeGlobalRules(includeGlobalRules);
      setSaveSuccess(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError)
      );
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges =
    content !== originalContent ||
    includeGlobalRules !== originalIncludeGlobalRules;

  return (
    <section
      className="personalization-section"
      aria-label={t("personalization.projectTitle")}
    >
      <div className="personalization-section-header">
        <div className="personalization-section-title">
          <span className="personalization-section-icon">
            <FolderOpen size={15} strokeWidth={2} />
          </span>
          <strong>
            {t("personalization.projectTitle", {
              defaultValue: "Project rules",
            })}
          </strong>
          <span>
            {t("personalization.projectInfo", {
              defaultValue:
                "Project-specific rules are added after the global rules.",
            })}
          </span>
        </div>
      </div>

      {activeDirectory ? (
        <div className="personalization-current-project">
          <span className="personalization-current-project-label">
            {t("personalization.currentProject", {
              defaultValue: "Current project",
            })}
          </span>
          <strong title={activeDirectory.path}>{activeDirectory.name}</strong>
          <span className="personalization-project-kind">
            {activeDirectory.path.startsWith("ssh://")
              ? "SSH"
              : t("personalization.projectKindLocal", {
                  defaultValue: "Local",
                })}
          </span>
        </div>
      ) : null}

      {activeDirectory ? (
        <div className="personalization-inheritance-row">
          <div className="personalization-inheritance-copy">
            <strong>
              {t("personalization.includeGlobalTitle", {
                defaultValue: "Load global rules",
              })}
            </strong>
            <span>
              {t("personalization.includeGlobalDesc", {
                defaultValue:
                  "Keep shared preferences active in this project. Project rules are applied afterwards.",
              })}
            </span>
          </div>
          <label className="toggle-switch">
            <input
              checked={includeGlobalRules}
              disabled={isLoading || isSaving}
              onChange={(event) => {
                setIncludeGlobalRules(event.target.checked);
                setSaveSuccess(false);
              }}
              type="checkbox"
            />
            <span className="toggle-slider" />
          </label>
        </div>
      ) : null}

      {!activeDirectory ? (
        <div className="personalization-empty">
          <FolderOpen size={20} />
          <span>
            {t("personalization.projectEmpty", {
              defaultValue:
                "No active project. Open or add a project from the sidebar to edit its ROLE.md.",
            })}
          </span>
        </div>
      ) : (
        <>
          <div className="personalization-toolbar">
            <div className="personalization-toolbar-main">
              <FileCode2 size={14} />
              <div className="personalization-toolbar-info">
                <span>
                  {t("personalization.projectScopeNote", {
                    defaultValue:
                      "Project rules are appended after global rules and take priority when instructions conflict.",
                  })}
                </span>
                {roleFilePath ? (
                  <small className="project-skills-path" title={roleFilePath}>
                    {roleFilePath}
                  </small>
                ) : null}
              </div>
            </div>
            <div>
              <button
                className="personalization-save-btn"
                disabled={isSaving || isLoading || !hasChanges}
                onClick={() => void handleSave()}
                type="button"
              >
                {isSaving ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <Save size={14} />
                )}
                <span>
                  {t("personalization.save", { defaultValue: "Save" })}
                </span>
              </button>
            </div>
          </div>

          {error ? (
            <div className="project-sensitive-command-error">
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          ) : null}

          {saveSuccess ? (
            <AutoDismissNotice
              message={t("personalization.projectSaved", {
                defaultValue: "Project rules saved.",
              })}
              tone="success"
              onDismiss={() => setSaveSuccess(false)}
            />
          ) : null}

          {isLoading ? (
            <div className="project-sensitive-command-state">
              <Loader2 className="spin" size={18} />
              <span>
                {t("roleEditor.loading", {
                  defaultValue: "Loading ROLE.md...",
                })}
              </span>
            </div>
          ) : (
            <>
              <textarea
                aria-label={t("personalization.projectTitle", {
                  defaultValue: "Project rules",
                })}
                className="personalization-textarea"
                onChange={(event) => {
                  setContent(event.target.value);
                  setSaveSuccess(false);
                }}
                placeholder={t("personalization.projectPlaceholder", {
                  defaultValue:
                    "Enter rules for this project here, e.g. code style, architecture conventions, tech stack notes...",
                })}
                spellCheck={false}
                value={content}
              />
              <div className="role-editor-footer">
                <small>
                  {t("personalization.globalHint", {
                    defaultValue:
                      "Changes take effect in the next conversation.",
                  })}
                </small>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
};
