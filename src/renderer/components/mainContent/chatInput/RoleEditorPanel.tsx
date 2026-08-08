import { AlertCircle, Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SshConnectParams, SshFileVersion } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { Modal } from "../../common/Modal";

const ROLE_FILE_NAME = "ROLE.md";

type ProjectDirectoryInfo = {
  path: string;
  isSsh: boolean;
};

type RoleEditorPanelProps = {
  open: boolean;
  projectId?: string;
  projectName?: string;
  onClose: () => void;
};

const resolveProjectDirectory = async (
  projectId: string
): Promise<ProjectDirectoryInfo | null> => {
  const directories = await window.snow.listWorkspaceDirectories();
  const matched = directories.find(
    (directory) => directory.directoryId === projectId
  );
  if (!matched) {
    return null;
  }
  return {
    path: matched.path,
    isSsh: matched.path.startsWith("ssh://"),
  };
};

const buildSshConnectParams = async (
  sshUrl: string
): Promise<SshConnectParams | null> => {
  const parsed = await window.snow.sshParseUrl(sshUrl);
  const credential = await window.snow.sshGetCredential(
    parsed.host,
    parsed.port,
    parsed.username
  );

  const connectParams: SshConnectParams = {
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    authMethod: credential?.authMethod ?? "password",
  };

  if (credential?.privateKeyPath) {
    connectParams.privateKeyPath = credential.privateKeyPath;
  }

  const secret = credential?.encryptedSecret
    ? await window.snow.sshGetDecryptedSecret(
        parsed.host,
        parsed.port,
        parsed.username
      )
    : null;

  if (secret) {
    if (connectParams.authMethod === "password") {
      connectParams.password = secret;
    } else {
      connectParams.passphrase = secret;
    }
  }

  return connectParams;
};

export const RoleEditorPanel = ({
  open,
  projectId,
  projectName,
  onClose,
}: RoleEditorPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [directoryInfo, setDirectoryInfo] =
    useState<ProjectDirectoryInfo | null>(null);
  const loadGenerationRef = useRef(0);
  const sshSessionIdRef = useRef<string | null>(null);
  const remoteRoleVersionRef = useRef<SshFileVersion>({ exists: false });

  const roleFilePath = directoryInfo
    ? directoryInfo.isSsh
      ? `${directoryInfo.path.replace(/^ssh:\/\/[^/]+/, "")}/${ROLE_FILE_NAME}`
      : `${directoryInfo.path}/${ROLE_FILE_NAME}`.replace(/\/+/g, "/")
    : null;

  const loadRoleFile = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setDirectoryInfo(null);
      setContent("");
      setOriginalContent("");
      setIsLoading(false);
      return;
    }

    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoading(true);
    setError(null);
    setSaveSuccess(false);
    setContent("");
    setOriginalContent("");
    remoteRoleVersionRef.current = { exists: false };

    try {
      const info = await resolveProjectDirectory(projectId);
      if (loadGenerationRef.current !== generation) return;

      if (!info) {
        setError(t("roleEditor.noProject"));
        setIsLoading(false);
        return;
      }

      setDirectoryInfo(info);

      const filePath = info.isSsh
        ? `${info.path.replace(/^ssh:\/\/[^/]+/, "")}/${ROLE_FILE_NAME}`
        : `${info.path}/${ROLE_FILE_NAME}`.replace(/\/+/g, "/");

      if (info.isSsh) {
        const connectParams = await buildSshConnectParams(info.path);
        if (loadGenerationRef.current !== generation) return;
        if (!connectParams) {
          setError(t("roleEditor.sshCredentialMissing"));
          setIsLoading(false);
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
  }, [projectId, t]);

  useEffect(() => {
    if (open) {
      void loadRoleFile();
      return;
    }

    loadGenerationRef.current += 1;
    setContent("");
    setOriginalContent("");
    setError(null);
    setSaveSuccess(false);
    setDirectoryInfo(null);
    setIsLoading(false);
  }, [loadRoleFile, open]);

  // Disconnect SSH session on unmount.
  useEffect(() => {
    return () => {
      if (sshSessionIdRef.current) {
        void window.snow.sshDisconnect(sshSessionIdRef.current);
        sshSessionIdRef.current = null;
      }
    };
  }, []);

  const handleSave = async (): Promise<void> => {
    if (!directoryInfo || !roleFilePath || !projectId || isSaving) return;

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      if (directoryInfo.isSsh) {
        if (!sshSessionIdRef.current) {
          const connectParams = await buildSshConnectParams(directoryInfo.path);
          if (!connectParams) {
            setError(t("roleEditor.sshCredentialMissing"));
            setIsSaving(false);
            return;
          }
          sshSessionIdRef.current = await window.snow.sshConnect(connectParams);
        }
        const writeResult = await window.snow.sshWriteFile(
          sshSessionIdRef.current,
          roleFilePath,
          content,
          {
            workspaceId: projectId,
            expectedVersion: remoteRoleVersionRef.current,
          }
        );
        remoteRoleVersionRef.current = writeResult.version;
      } else {
        await window.snow.writeFileContent(roleFilePath, content);
      }

      setOriginalContent(content);
      setSaveSuccess(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError)
      );
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = content !== originalContent;

  return (
    <Modal
      className="role-editor-modal"
      closeLabel={t("roleEditor.close")}
      description={
        projectId
          ? t("roleEditor.description", {
              values: { project: projectName || projectId },
            })
          : t("roleEditor.noProject")
      }
      onClose={onClose}
      open={open}
      size="large"
      title={t("roleEditor.title")}
    >
      {!projectId ? (
        <div className="project-sensitive-command-state">
          <AlertCircle size={18} />
          <span>{t("roleEditor.noProject")}</span>
        </div>
      ) : isLoading ? (
        <div className="project-sensitive-command-state">
          <Loader2 className="spin" size={18} />
          <span>{t("roleEditor.loading")}</span>
        </div>
      ) : (
        <>
          <div className="project-sensitive-command-toolbar">
            <div>
              <span>{t("roleEditor.scopeNote")}</span>
              {roleFilePath ? (
                <small className="project-skills-path" title={roleFilePath}>
                  {roleFilePath}
                </small>
              ) : null}
            </div>
            <div>
              <button
                className="project-sensitive-command-save"
                disabled={isSaving || !hasChanges}
                onClick={() => void handleSave()}
                type="button"
              >
                {isSaving ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <Save size={14} />
                )}
                <span>{t("roleEditor.save")}</span>
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
              message={t("roleEditor.saved")}
              tone="success"
              onDismiss={() => setSaveSuccess(false)}
            />
          ) : null}

          <textarea
            aria-label={t("roleEditor.title")}
            className="role-editor-textarea"
            onChange={(event) => {
              setContent(event.target.value);
              setSaveSuccess(false);
            }}
            placeholder={t("roleEditor.placeholder")}
            spellCheck={false}
            value={content}
          />

          <div className="role-editor-footer">
            <small>{t("roleEditor.hint")}</small>
          </div>
        </>
      )}
    </Modal>
  );
};
