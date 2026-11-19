import { useState } from "react";
import { ImageUp, Pencil, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useI18n } from "../../../i18n";
import { ChatImAvatar } from "../../mainContent/chatMessages/components/ChatImAvatar";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";
import type { ThemeCharacterCard, ThemeChatStyle } from "./types";

export type ChatAvatarRole = "ai" | "user";

type ThemeChatStyleSectionProps = {
  chatStyle: ThemeChatStyle;
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
  onSelectAvatar: (role: ChatAvatarRole) => Promise<void>;
  onResetAvatar: (role: ChatAvatarRole) => Promise<void>;
  onGenerateCharacterCard: () => void;
  onSaveCharacterCard: (card: ThemeCharacterCard) => void;
  onRemoveCharacterCard: () => void;
};

/** 角色卡可编辑字段：key 对应 ThemeCharacterCard，rows 为编辑态文本框行数。 */
type CharacterCardFieldKey =
  "personality" | "speakingStyle" | "background" | "greeting";

export function ThemeChatStyleSection({
  chatStyle,
  disabled,
  onToggle,
  onSelectAvatar,
  onResetAvatar,
  onGenerateCharacterCard,
  onSaveCharacterCard,
  onRemoveCharacterCard,
}: ThemeChatStyleSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const [editingCard, setEditingCard] = useState(false);
  const [cardDraft, setCardDraft] = useState<ThemeCharacterCard | null>(null);

  const renderAvatarCard = (role: ChatAvatarRole): React.JSX.Element => {
    const path =
      role === "ai" ? chatStyle.aiAvatarPath : chatStyle.userAvatarPath;
    return (
      <div className="theme-chat-avatar-card">
        <ChatImAvatar
          role={role === "ai" ? "assistant" : "user"}
          path={path}
          className="theme-chat-avatar-preview"
        />
        <div className="theme-chat-avatar-meta">
          <span className="theme-chat-avatar-label">
            {role === "ai"
              ? t("settings.themeChatStyleAiAvatar", {
                  defaultValue: "AI avatar",
                })
              : t("settings.themeChatStyleUserAvatar", {
                  defaultValue: "My avatar",
                })}
            <ApiSettingsHintIcon
              hint={
                path
                  ? t("settings.themeChatStyleAvatarCustom", {
                      defaultValue: "Custom image",
                    })
                  : role === "ai"
                    ? t("settings.themeChatStyleAiAvatarDefault", {
                        defaultValue: "Default: built-in pet",
                      })
                    : t("settings.themeChatStyleUserAvatarDefault", {
                        defaultValue: "Default icon",
                      })
              }
            />
          </span>
        </div>
        <div className="theme-chat-avatar-actions">
          <button
            type="button"
            className="api-settings-form-btn secondary"
            onClick={() => void onSelectAvatar(role)}
            disabled={disabled}
          >
            <ImageUp size={15} strokeWidth={1.8} />
            <span>
              {t("settings.themeChatStyleChangeAvatar", {
                defaultValue: "Change",
              })}
            </span>
          </button>
          <button
            type="button"
            className="api-settings-form-btn secondary"
            onClick={() => void onResetAvatar(role)}
            disabled={disabled || !path}
          >
            <RotateCcw size={15} strokeWidth={1.8} />
            <span>
              {t("settings.themeChatStyleResetAvatar", {
                defaultValue: "Reset",
              })}
            </span>
          </button>
        </div>
      </div>
    );
  };

  const card = chatStyle.characterCard;
  const hasCard = Boolean(card.name);

  const characterFields: Array<{
    key: CharacterCardFieldKey;
    label: string;
    rows: number;
  }> = [
    {
      key: "personality",
      label: t("settings.themeCharacterCardPersonality", {
        defaultValue: "Personality",
      }),
      rows: 3,
    },
    {
      key: "speakingStyle",
      label: t("settings.themeCharacterCardSpeakingStyle", {
        defaultValue: "Speaking style",
      }),
      rows: 3,
    },
    {
      key: "background",
      label: t("settings.themeCharacterCardBackground", {
        defaultValue: "Background",
      }),
      rows: 3,
    },
    {
      key: "greeting",
      label: t("settings.themeCharacterCardGreeting", {
        defaultValue: "Opening line",
      }),
      rows: 2,
    },
  ];

  // 展示态只保留有内容的字段，避免空行撑开卡片。
  const filledFields = characterFields.filter((field) => card[field.key]);

  const handleStartEdit = (): void => {
    setCardDraft({ ...card });
    setEditingCard(true);
  };

  const handleCancelEdit = (): void => {
    setCardDraft(null);
    setEditingCard(false);
  };

  const handleDraftChange = (
    key: keyof ThemeCharacterCard,
    value: string,
  ): void => {
    setCardDraft((previous) =>
      previous ? { ...previous, [key]: value } : previous,
    );
  };

  const handleSaveEdit = (): void => {
    if (!cardDraft || !cardDraft.name.trim()) {
      return;
    }
    onSaveCharacterCard(cardDraft);
    setCardDraft(null);
    setEditingCard(false);
  };

  const cardNameLabel = t("settings.themeCharacterCardName", {
    defaultValue: "Name",
  });
  const cardTaglineLabel = t("settings.themeCharacterCardTagline", {
    defaultValue: "Tagline",
  });

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {t("settings.themeChatStyleTitle", {
            defaultValue: "IM chat style",
          })}
          <ApiSettingsHintIcon
            hint={t("settings.themeChatStyleInfo", {
              defaultValue:
                "Show avatars next to messages like an instant messenger. Avatars can be replaced with your own images.",
            })}
          />
        </strong>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={chatStyle.imMode}
            onChange={(event) => onToggle(event.target.checked)}
            disabled={disabled}
            hidden
          />
          <span className="toggle-slider" />
          <span>
            {chatStyle.imMode
              ? t("settings.enabled", { defaultValue: "Enabled" })
              : t("settings.disabled", { defaultValue: "Disabled" })}
          </span>
        </label>
      </div>
      {chatStyle.imMode ? (
        <>
          <div className="theme-chat-avatar-list">
            {renderAvatarCard("ai")}
            {renderAvatarCard("user")}
          </div>
          <div className="theme-character-card">
            <div className="theme-character-card-head">
              <div className="theme-character-card-identity">
                <span className="theme-character-card-title">
                  {t("settings.themeCharacterCardTitle", {
                    defaultValue: "Character card",
                  })}
                  <ApiSettingsHintIcon
                    hint={t("settings.themeCharacterCardInfo", {
                      defaultValue:
                        "Generate a character card from the AI avatar and inject it into the system prompt, so the AI chats in that persona. The card only applies while IM style is enabled.",
                    })}
                  />
                </span>
              </div>
              <div className="theme-character-card-actions">
                {editingCard ? (
                  <>
                    <button
                      type="button"
                      className="api-settings-form-btn secondary"
                      onClick={handleCancelEdit}
                    >
                      <span>
                        {t("settings.themeCharacterCardCancel", {
                          defaultValue: "Cancel",
                        })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="api-settings-form-btn primary"
                      onClick={handleSaveEdit}
                      disabled={disabled || !cardDraft?.name.trim()}
                    >
                      <span>
                        {t("settings.themeCharacterCardSave", {
                          defaultValue: "Save",
                        })}
                      </span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="api-settings-form-btn secondary"
                      onClick={onGenerateCharacterCard}
                      disabled={disabled}
                    >
                      <Sparkles size={15} strokeWidth={1.8} />
                      <span>
                        {hasCard
                          ? t("settings.themeCharacterCardRegenerate", {
                              defaultValue: "Regenerate",
                            })
                          : t("settings.themeCharacterCardGenerate", {
                              defaultValue: "AI character card",
                            })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="api-settings-form-btn secondary"
                      onClick={handleStartEdit}
                      disabled={disabled}
                    >
                      <Pencil size={15} strokeWidth={1.8} />
                      <span>
                        {t("settings.themeCharacterCardEdit", {
                          defaultValue: "Edit",
                        })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="api-settings-form-btn secondary"
                      onClick={onRemoveCharacterCard}
                      disabled={disabled || !hasCard}
                    >
                      <Trash2 size={15} strokeWidth={1.8} />
                      <span>
                        {t("settings.themeCharacterCardRemove", {
                          defaultValue: "Remove",
                        })}
                      </span>
                    </button>
                  </>
                )}
              </div>
            </div>
            {editingCard && cardDraft ? (
              <div className="theme-character-card-edit">
                <div className="theme-character-card-edit-grid">
                  <label className="theme-character-card-edit-field">
                    <span>{cardNameLabel}</span>
                    <input
                      type="text"
                      value={cardDraft.name}
                      onChange={(event) =>
                        handleDraftChange("name", event.target.value)
                      }
                      disabled={disabled}
                    />
                  </label>
                  <label className="theme-character-card-edit-field">
                    <span>{cardTaglineLabel}</span>
                    <input
                      type="text"
                      value={cardDraft.tagline}
                      onChange={(event) =>
                        handleDraftChange("tagline", event.target.value)
                      }
                      disabled={disabled}
                    />
                  </label>
                </div>
                {characterFields.map((field) => (
                  <label
                    className="theme-character-card-edit-field"
                    key={field.key}
                  >
                    <span>{field.label}</span>
                    <textarea
                      rows={field.rows}
                      value={cardDraft[field.key]}
                      onChange={(event) =>
                        handleDraftChange(field.key, event.target.value)
                      }
                      disabled={disabled}
                    />
                  </label>
                ))}
              </div>
            ) : hasCard ? (
              <div className="theme-character-card-body">
                <div className="theme-character-card-name-row">
                  <span className="theme-character-card-name">{card.name}</span>
                  {card.tagline ? (
                    <span className="theme-character-card-tagline">
                      {card.tagline}
                    </span>
                  ) : null}
                </div>
                {filledFields.length > 0 ? (
                  <dl className="theme-character-card-fields">
                    {filledFields.map((field) => (
                      <div
                        className="theme-character-card-field"
                        key={field.key}
                      >
                        <dt>{field.label}</dt>
                        <dd>{card[field.key]}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            ) : (
              <p className="theme-character-card-empty">
                {t("settings.themeCharacterCardEmpty", {
                  defaultValue:
                    "No character card yet. Generate one from the AI avatar to give the AI a persona.",
                })}
              </p>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
