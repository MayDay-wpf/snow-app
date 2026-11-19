import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { CustomSelect } from "../../common/CustomSelect";
import { Modal } from "../../common/Modal";
import { ChatImAvatar } from "../../mainContent/chatMessages/components/ChatImAvatar";
import { MarkdownBlock } from "../../mainContent/chatMessages/components/markdownRenderer";
import { getActiveLocale, useI18n } from "../../../i18n";
import { useDefaultPetAvatar } from "../../pet/petAvatar";
import { normalizeThemeCharacterCard } from "./themeSettingsUtils";
import type { ApiConfigRecord, ThemeCharacterCard } from "../../../../preload";

/** 角色卡字段的输出语言：跟随界面语言，避免生成中英混杂的人设。 */
const CHARACTER_CARD_LANGUAGE_BY_LOCALE: Record<string, string> = {
  "zh-CN": "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  en: "English",
};

type CharacterCardModalProps = {
  open: boolean;
  /** 角色卡来源：IM 风格中已设置的 AI 头像路径，可为空。 */
  avatarPath: string;
  onClose: () => void;
  onApply: (card: ThemeCharacterCard) => void;
};

export function ThemeCharacterCardModal({
  open,
  avatarPath,
  onClose,
  onApply,
}: CharacterCardModalProps): React.JSX.Element {
  const { t } = useI18n();
  // 默认头像（内置宠物形象）同样可以作为角色卡来源。
  const defaultAvatar = useDefaultPetAvatar(true);
  const [configs, setConfigs] = useState<ApiConfigRecord[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const streamIdRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (streamIdRef.current) {
        void window.snow.abortCharacterCard(streamIdRef.current).catch(() => {
          // Ignore abort errors on unmount.
        });
      }
    };
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadConfigs();
  }, [open]);

  const loadConfigs = async (): Promise<void> => {
    try {
      const list = await window.snow.listApiConfigs();
      if (!isMountedRef.current) {
        return;
      }
      setConfigs(list);
      const active = list.find((config) => config.isActive);
      setSelectedProfile(active?.profileName ?? list[0]?.profileName ?? "");
    } catch (e) {
      if (isMountedRef.current) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.themeCharacterCardLoadConfigsError", {
                defaultValue: "Failed to load API configurations.",
              }),
        );
      }
    }
  };

  const profileOptions = useMemo(
    () =>
      configs.map((config) => ({
        value: config.profileName,
        label: config.displayName.trim() || config.profileName,
      })),
    [configs],
  );

  const selectedConfig = useMemo(
    () => configs.find((config) => config.profileName === selectedProfile),
    [configs, selectedProfile],
  );

  const supportsVision = selectedConfig?.supportsVision ?? false;
  // 自定义头像优先，其次是默认头像的 data URL；两者都未就绪时等待。
  const avatarSource = avatarPath || defaultAvatar || "";
  const avatarPending = !avatarPath && !defaultAvatar;

  const handleGenerate = async (): Promise<void> => {
    if (!avatarSource) {
      setError(
        t("settings.themeCharacterCardNoAvatarError", {
          defaultValue:
            "The avatar is not ready yet. Please try again in a moment.",
        }),
      );
      return;
    }
    if (!selectedProfile) {
      setError(
        t("settings.themeCharacterCardNoProfileError", {
          defaultValue: "Please select an API configuration.",
        }),
      );
      return;
    }

    setLoading(true);
    setError("");
    setStatus("");
    setStreamingContent("");

    try {
      const locale = getActiveLocale();
      const result = await window.snow.generateCharacterCard(
        avatarSource,
        selectedProfile,
        CHARACTER_CARD_LANGUAGE_BY_LOCALE[locale] ?? "English",
        (chunk) => {
          if (!isMountedRef.current) {
            return;
          }
          if (chunk.contentDelta) {
            setStreamingContent((previous) => previous + chunk.contentDelta);
          }
        },
        (streamId) => {
          streamIdRef.current = streamId;
        },
      );

      streamIdRef.current = null;
      if (!isMountedRef.current) {
        return;
      }

      const parsed = parseCharacterCardJson(result.content);
      if (!parsed) {
        setError(
          t("settings.themeCharacterCardParseError", {
            defaultValue:
              "Failed to parse the AI-generated character card. Please try again.",
          }),
        );
        return;
      }

      onApply(parsed);
      setStatus(
        t("settings.themeCharacterCardSuccess", {
          defaultValue: "AI character card generated and applied.",
        }),
      );
    } catch (e) {
      if (isMountedRef.current) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.themeCharacterCardGenerateError", {
                defaultValue: "Failed to generate the character card.",
              }),
        );
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  };

  const handleCancel = useCallback((): void => {
    if (streamIdRef.current) {
      void window.snow.abortCharacterCard(streamIdRef.current).catch(() => {
        // Ignore abort errors.
      });
      streamIdRef.current = null;
    }
    setLoading(false);
  }, []);

  const handleClose = (): void => {
    handleCancel();
    setError("");
    setStatus("");
    setStreamingContent("");
    onClose();
  };

  return (
    <Modal
      open={open}
      title={t("settings.themeCharacterCardModalTitle", {
        defaultValue: "AI character card",
      })}
      description={t("settings.themeCharacterCardModalDescription", {
        defaultValue:
          "Generate a character card from your AI avatar. The card is injected into the system prompt so the AI chats in that persona while IM style is enabled.",
      })}
      closeLabel={t("settings.themeCharacterCardModalClose", {
        defaultValue: "Close AI character card",
      })}
      onClose={handleClose}
      closeDisabled={loading}
      size="medium"
      footer={
        <>
          <button
            className="api-settings-form-btn primary"
            onClick={handleGenerate}
            type="button"
            disabled={loading || !selectedProfile || !avatarSource}
          >
            {loading ? (
              <Loader2 size={14} strokeWidth={1.9} className="spin" />
            ) : (
              <Sparkles size={14} strokeWidth={1.9} />
            )}
            <span>
              {loading
                ? t("settings.themeCharacterCardGenerating", {
                    defaultValue: "Generating...",
                  })
                : t("settings.themeCharacterCardModalGenerate", {
                    defaultValue: "Generate",
                  })}
            </span>
          </button>
          {loading ? (
            <button
              className="api-settings-form-btn secondary"
              onClick={handleCancel}
              type="button"
            >
              <X size={14} strokeWidth={1.9} />
              <span>
                {t("settings.themeCharacterCardCancel", {
                  defaultValue: "Cancel",
                })}
              </span>
            </button>
          ) : null}
        </>
      }
    >
      <div className="theme-ai-color-modal">
        <AutoDismissNotice
          message={error || status}
          tone={error ? "error" : "success"}
          onDismiss={() => {
            setError("");
            setStatus("");
          }}
        />

        <div className="theme-ai-color-field">
          <label className="theme-ai-color-label">
            {t("settings.themeCharacterCardAvatarLabel", {
              defaultValue: "AI avatar",
            })}
          </label>
          <div className="theme-character-card-image-row">
            <ChatImAvatar
              role="assistant"
              path={avatarPath}
              className="theme-chat-avatar-preview"
            />
            <span className="theme-chat-avatar-hint">
              {avatarPath
                ? t("settings.themeCharacterCardAvatarHint", {
                    defaultValue:
                      "The card is generated from this avatar. Regenerate after changing it.",
                  })
                : avatarPending
                  ? t("settings.themeCharacterCardAvatarLoading", {
                      defaultValue: "Preparing the default avatar...",
                    })
                  : t("settings.themeCharacterCardDefaultAvatarHint", {
                      defaultValue:
                        "No custom AI avatar; the default avatar (built-in pet) is used.",
                    })}
            </span>
          </div>
        </div>

        <div className="theme-ai-color-field">
          <label className="theme-ai-color-label">
            {t("settings.themeAiColorProfileLabel", {
              defaultValue: "API configuration",
            })}
          </label>
          <CustomSelect
            value={selectedProfile}
            options={profileOptions}
            onChange={setSelectedProfile}
            disabled={loading || configs.length === 0}
            portal
          />
        </div>

        <p className="theme-ai-color-hint">
          {t("settings.themeCharacterCardVisionHint", {
            defaultValue:
              'Character card generation requires the selected profile\'s advanced model to support vision. Make sure "Supports vision" is enabled in API settings.',
          })}
        </p>

        {!supportsVision && selectedConfig ? (
          <p className="theme-ai-color-warning">
            {t("settings.themeAiColorVisionWarning", {
              defaultValue:
                "The selected profile's advanced model is marked as not supporting vision. Generation may fail.",
            })}
          </p>
        ) : null}

        {streamingContent ? (
          <div className="theme-ai-color-preview">
            <MarkdownBlock
              className="context-compaction-markdown theme-ai-color-markdown"
              content={streamingContent}
              streaming={loading}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/// 解析 AI 输出的角色卡 JSON，容忍 markdown 代码块与前后说明文字。
function parseCharacterCardJson(content: string): ThemeCharacterCard | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const card = normalizeThemeCharacterCard(parsed);
  return card.name ? card : null;
}
