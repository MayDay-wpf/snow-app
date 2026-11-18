/**
 * 桌面宠物独立设置页。
 *
 * 与其它设置页保持一致的结构：页头（标题 + 描述 + 关闭按钮）+
 * api-settings-manual-form 表单卡片（分区：当前宠物、宠物聊天、已安装宠物列表）。
 * 支持：唤醒/收起、安装 Codex 宠物包（.zip）、选择激活宠物、
 * 卸载 Snow App 安装的宠物（内置宠物不提供卸载入口），调整显示大小与动画播放速度（带实时预览）、
 * 编辑每只宠物的人设，以及宠物聊天使用的 API 配置与模型
 * （默认为跟随当前配置的高级模型）。
 */
import { Loader2, PackagePlus, PawPrint, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { ApiConfigRecord, Model } from "../../../preload";
import type { PetManifest, PetSettings } from "../../../preload/types/pets";
import { PetPreview } from "../pet/PetPreview";
import { PetStage } from "../pet/PetStage";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { CustomSelect } from "../common/CustomSelect";
import { RangeSlider } from "../common/RangeSlider";
import { ApiModelCombobox } from "./apiSettings/ApiModelCombobox";
import { ApiSettingsHintIcon } from "./apiSettings/ApiSettingsFieldLabel";
import { PetPersonaDialog } from "./pets/PetPersonaDialog";

/** 预览区宠物动画的固定缩放（约 96×104 px，与列表缩略图区分开）。 */
const PREVIEW_SCALE = 0.5;
/** 宠物聊天模型输入的提交防抖（避免逐字符写库）。 */
const PET_CHAT_TIMER_MS = 250;

export function PetsSettingsPanel(): React.JSX.Element {
  const { t } = useI18n();

  const [pets, setPets] = useState<PetManifest[]>([]);
  const [petSettings, setPetSettings] = useState<PetSettings | null>(null);
  const [petInstalling, setPetInstalling] = useState(false);
  const [petInstallError, setPetInstallError] = useState<string | null>(null);
  const [petScaleDraft, setPetScaleDraft] = useState<number | null>(null);
  const [petSpeedDraft, setPetSpeedDraft] = useState<number | null>(null);
  const [petPendingDeletion, setPetPendingDeletion] =
    useState<PetManifest | null>(null);
  // 人设编辑：被编辑的宠物 + 草稿文本（保存成功或取消后清空）。
  const [personaTarget, setPersonaTarget] = useState<PetManifest | null>(null);
  const [personaDraft, setPersonaDraft] = useState("");
  const [personaSaving, setPersonaSaving] = useState(false);
  const [apiConfigs, setApiConfigs] = useState<ApiConfigRecord[]>([]);
  const [chatModels, setChatModels] = useState<Model[]>([]);
  const [chatModelsLoading, setChatModelsLoading] = useState(false);
  const [chatModelsError, setChatModelsError] = useState<string | null>(null);
  const [chatModelsLoadedFor, setChatModelsLoadedFor] = useState<string | null>(
    null,
  );
  const petScaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const petSpeedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 速度草稿的镜像：写库返回前保持滑杆不回退，避免拖动时抖动。
  const petSpeedDraftRef = useRef<number | null>(null);
  const petChatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatModelRequestRef = useRef(0);

  const reloadPets = (): Promise<void> =>
    Promise.all([
      window.snow.listInstalledPets(),
      window.snow.getPetSettings(),
      window.snow.listApiConfigs(),
    ])
      .then(([petList, settings, configs]) => {
        setPets(petList);
        setPetSettings(settings);
        setApiConfigs(configs);
      })
      .catch(() => undefined);

  useEffect(() => {
    void reloadPets();
    const unsubscribe = window.snow.onPetsChanged(() => {
      void reloadPets();
    });
    return () => {
      unsubscribe();
      if (petScaleTimerRef.current) {
        clearTimeout(petScaleTimerRef.current);
        petScaleTimerRef.current = null;
      }
      if (petSpeedTimerRef.current) {
        clearTimeout(petSpeedTimerRef.current);
        petSpeedTimerRef.current = null;
      }
      if (petChatTimerRef.current) {
        clearTimeout(petChatTimerRef.current);
        petChatTimerRef.current = null;
      }
    };
  }, []);

  const handleInstallPet = (): void => {
    if (petInstalling) {
      return;
    }
    setPetInstalling(true);
    setPetInstallError(null);
    window.snow
      .installPetFromZip()
      .catch((error: unknown) => {
        setPetInstallError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        setPetInstalling(false);
        void reloadPets();
      });
  };

  const handlePetEnabledChange = (enabled: boolean): void => {
    if (!petSettings) {
      return;
    }
    const previous = petSettings;
    // 尚未选择宠物时，首次唤醒视为选择第一只宠物。
    if (enabled && !previous.activePetId && pets.length > 0) {
      // 乐观更新：开关立即响应点击，IPC 完成后对账、失败回滚。
      setPetSettings({ ...previous, enabled: true, activePetId: pets[0].id });
      window.snow
        .setActivePet(pets[0].id)
        .then(() => window.snow.setPetEnabled(true))
        .then(setPetSettings)
        .catch(() => setPetSettings(previous));
      return;
    }
    setPetSettings({ ...previous, enabled });
    window.snow
      .setPetEnabled(enabled)
      .then(setPetSettings)
      .catch(() => setPetSettings(previous));
  };

  const handleSelectPet = (petId: string): void => {
    if (!petSettings) {
      return;
    }
    const previous = petSettings;
    setPetSettings({ ...previous, activePetId: petId });
    window.snow
      .setActivePet(petId)
      .then(setPetSettings)
      .catch(() => setPetSettings(previous));
  };

  const handleUninstallPet = (pet: PetManifest): void => {
    setPetPendingDeletion(pet);
  };

  const confirmUninstallPet = (): void => {
    if (!petPendingDeletion) {
      return;
    }
    const pet = petPendingDeletion;
    setPetPendingDeletion(null);
    window.snow
      .uninstallPet(pet.id)
      .then(() => reloadPets())
      .catch((error: unknown) => {
        setPetInstallError(
          error instanceof Error ? error.message : String(error),
        );
      });
  };

  // ── 宠物人设编辑 ────────────────────────────────────────────────────

  const handleEditPersona = (pet: PetManifest): void => {
    setPersonaTarget(pet);
    setPersonaDraft(petSettings?.personas[pet.id] ?? "");
  };

  const handleClosePersona = (): void => {
    if (personaSaving) {
      return;
    }
    setPersonaTarget(null);
    setPersonaDraft("");
  };

  const handleSavePersona = (): void => {
    const pet = personaTarget;
    if (!pet || personaSaving) {
      return;
    }
    setPersonaSaving(true);
    window.snow
      .setPetPersona(pet.id, personaDraft)
      .then(setPetSettings)
      .then(() => {
        setPersonaTarget(null);
        setPersonaDraft("");
      })
      .catch((error: unknown) => {
        setPetInstallError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => setPersonaSaving(false));
  };

  const handlePetScaleChange = (value: number): void => {
    setPetScaleDraft(value);
    if (petScaleTimerRef.current) {
      clearTimeout(petScaleTimerRef.current);
    }
    // 防抖提交：避免拖动滑杆时频繁重建宠物窗口。
    petScaleTimerRef.current = setTimeout(() => {
      petScaleTimerRef.current = null;
      setPetScaleDraft(null);
      window.snow
        .setPetScale(value)
        .then(setPetSettings)
        .catch(() => undefined);
    }, 250);
  };

  // 草稿只在写库返回后才清空，中途不清空，否则滑杆会先跳回旧值再跳回来。
  const commitPetSpeed = (): void => {
    const value = petSpeedDraftRef.current;
    if (value == null) {
      return;
    }
    if (petSpeedTimerRef.current) {
      clearTimeout(petSpeedTimerRef.current);
      petSpeedTimerRef.current = null;
    }
    const settle = (): void => {
      if (petSpeedDraftRef.current === value) {
        petSpeedDraftRef.current = null;
        setPetSpeedDraft(null);
      }
    };
    window.snow
      .setPetSpeed(value)
      .then(setPetSettings)
      .then(settle)
      .catch(settle);
  };

  const handlePetSpeedChange = (value: number): void => {
    petSpeedDraftRef.current = value;
    setPetSpeedDraft(value);
    if (petSpeedTimerRef.current) {
      clearTimeout(petSpeedTimerRef.current);
    }
    // 防抖提交：避免拖动滑杆时频繁重建宠物窗口（预览区仍实时跟随）。
    petSpeedTimerRef.current = setTimeout(() => {
      petSpeedTimerRef.current = null;
      commitPetSpeed();
    }, 250);
  };

  // ── 宠物聊天：API 配置与模型 ────────────────────────────────────────
  //
  // 默认「跟随当前使用的配置 + 高级模型」：宠物设置里存 null，请求时不带
  // apiProfile / model，由 Rust 按主流程同一套解析规则兜底。

  const activeApiConfig = useMemo(
    () => apiConfigs.find((config) => config.isActive) ?? null,
    [apiConfigs],
  );
  const chatProfileName = petSettings?.apiProfile ?? "";
  const chatConfig = useMemo(() => {
    if (!chatProfileName) {
      return activeApiConfig;
    }
    return (
      apiConfigs.find((config) => config.profileName === chatProfileName) ??
      activeApiConfig
    );
  }, [activeApiConfig, apiConfigs, chatProfileName]);

  const loadChatModels = (force = false): void => {
    if (!chatConfig) {
      return;
    }
    const cacheKey = chatConfig.profileName;
    if (chatModelsLoading || (!force && chatModelsLoadedFor === cacheKey)) {
      return;
    }
    const requestId = chatModelRequestRef.current + 1;
    chatModelRequestRef.current = requestId;
    setChatModelsLoading(true);
    setChatModelsError(null);
    window.snow
      .fetchAvailableModelsForConfig({
        baseUrl: chatConfig.baseUrl,
        baseUrlMode: chatConfig.baseUrlMode,
        apiKey: chatConfig.apiKey,
        requestMethod: chatConfig.requestMethod,
        customHeaderSchemeId: chatConfig.customHeaderSchemeId,
        configJson: chatConfig.configJson.trim() || undefined,
      })
      .then((available) => {
        if (chatModelRequestRef.current !== requestId) {
          return;
        }
        setChatModels(available);
        setChatModelsLoadedFor(cacheKey);
      })
      .catch((error: unknown) => {
        if (chatModelRequestRef.current !== requestId) {
          return;
        }
        setChatModelsError(
          error instanceof Error
            ? error.message
            : t("chat.loadModelsError", {
                defaultValue: "Failed to load models",
              }),
        );
        setChatModelsLoadedFor(null);
      })
      .finally(() => {
        if (chatModelRequestRef.current === requestId) {
          setChatModelsLoading(false);
        }
      });
  };

  const handlePetApiProfileChange = (profileName: string): void => {
    if (!petSettings) {
      return;
    }
    const previous = petSettings;
    // 换配置后原模型 id 未必存在，一并清回「跟随高级模型」。
    setPetSettings({
      ...previous,
      apiProfile: profileName || null,
      model: null,
    });
    setChatModels([]);
    setChatModelsLoadedFor(null);
    window.snow
      .setPetApiProfile(profileName || null)
      .then(() => window.snow.setPetChatModel(null))
      .then(setPetSettings)
      .catch(() => setPetSettings(previous));
  };

  const handlePetChatModelChange = (model: string): void => {
    if (!petSettings) {
      return;
    }
    const previous = petSettings;
    const normalized = model.trim() || null;
    setPetSettings({ ...previous, model: normalized });
    if (petChatTimerRef.current) {
      clearTimeout(petChatTimerRef.current);
    }
    // 防抖提交：模型名可自由输入，避免逐字符写库。
    petChatTimerRef.current = setTimeout(() => {
      petChatTimerRef.current = null;
      window.snow
        .setPetChatModel(normalized)
        .then(setPetSettings)
        .catch(() => setPetSettings(previous));
    }, PET_CHAT_TIMER_MS);
  };

  const hasPets = pets.length > 0;
  const petEnabled = hasPets && (petSettings?.enabled ?? false);
  // 预览区优先使用激活宠物，未选择时回退到列表第一只。
  const previewManifest =
    pets.find((pet) => pet.id === petSettings?.activePetId) ?? pets[0] ?? null;
  const petSpeed = petSpeedDraft ?? petSettings?.speed ?? 1;

  const chatProfileLabel = activeApiConfig
    ? activeApiConfig.displayName.trim() || activeApiConfig.profileName
    : "";
  const chatModelPlaceholder = chatConfig?.advancedModel?.trim()
    ? t("settings.petsChatModelFollow", {
        values: { model: chatConfig.advancedModel.trim() },
        defaultValue: `Follow the advanced model (${chatConfig.advancedModel.trim()})`,
      })
    : t("settings.petsChatModelDefault", {
        defaultValue: "Follow the advanced model",
      });

  const petSourceLabel = (source: string): string => {
    if (source === "codex") {
      return t("settings.petsSourceCodex", { defaultValue: "Codex App" });
    }
    if (source === "petdex") {
      return t("settings.petsSourcePetdex", { defaultValue: "Petdex" });
    }
    return t("settings.petsSourceSnow", { defaultValue: "Snow App" });
  };

  return (
    <div className="api-settings-page" role="region">
      {petInstallError && (
        <span className="settings-update-error">{petInstallError}</span>
      )}

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.petsManageTitle", { defaultValue: "Manage pets" })}
            <ApiSettingsHintIcon
              hint={t("settings.petsManageInfo", {
                defaultValue:
                  "Wake or dismiss the pet, adjust its size, and pick the active pet.",
              })}
            />
          </strong>
        </div>

        <div className="api-settings-form-body">
          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.petsActiveSection", {
                  defaultValue: "Active pet",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.petsActiveInfo", {
                    defaultValue:
                      "Show or hide the desktop pet on your screen.",
                  })}
                />
              </strong>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={petEnabled}
                  onChange={(event) =>
                    handlePetEnabledChange(event.target.checked)
                  }
                  disabled={!petSettings || !hasPets}
                  hidden
                />
                <span className="toggle-slider" />
                <span>
                  {petEnabled
                    ? t("settings.petsDismiss", {
                        defaultValue: "Put pet away",
                      })
                    : t("settings.petsWake", {
                        defaultValue: "Wake up pet",
                      })}
                </span>
              </label>
            </div>
            {petEnabled && (
              <RangeSlider
                label={t("settings.petsScale", { defaultValue: "Size" })}
                value={petScaleDraft ?? petSettings?.scale ?? 0.75}
                min={0.5}
                max={2}
                step={0.05}
                onChange={handlePetScaleChange}
              />
            )}

            {previewManifest && (
              <div className="pets-speed-row">
                <RangeSlider
                  className="pets-speed-slider"
                  label={t("settings.petsSpeed", {
                    defaultValue: "Animation speed",
                  })}
                  value={petSpeed}
                  min={0.5}
                  max={2}
                  step={0.05}
                  formatValue={(value) => `${Math.round(value * 100)}%`}
                  onChange={handlePetSpeedChange}
                  onCommit={commitPetSpeed}
                />
                <div className="pets-speed-preview">
                  <PetStage
                    manifest={previewManifest}
                    scale={PREVIEW_SCALE}
                    speed={petSpeed}
                    activity="idle"
                    dragState={null}
                  />
                  <span className="pets-speed-preview-label">
                    {t("settings.petsSpeedPreview", {
                      defaultValue: "Preview",
                    })}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.petsChatSection", { defaultValue: "Pet chat" })}
                <ApiSettingsHintIcon
                  hint={t("settings.petsChatInfo", {
                    defaultValue:
                      "Double-click the pet to open a small chat window. It answers with your current session as background, and falls back to small talk when no session is open.",
                  })}
                />
              </strong>
            </div>

            <div className="api-settings-form-grid">
              <label className="api-settings-field">
                <span>
                  {t("settings.petsChatApiProfile", {
                    defaultValue: "API config",
                  })}
                </span>
                <CustomSelect
                  onChange={handlePetApiProfileChange}
                  options={[
                    {
                      value: "",
                      label: chatProfileLabel
                        ? t("settings.petsChatFollowActive", {
                            values: { name: chatProfileLabel },
                            defaultValue: `Follow the current config (${chatProfileLabel})`,
                          })
                        : t("settings.petsChatFollowCurrent", {
                            defaultValue: "Follow the current config",
                          }),
                    },
                    ...apiConfigs.map((config) => ({
                      value: config.profileName,
                      label: `${config.displayName.trim() || config.profileName}${
                        config.isActive
                          ? ` (${t("settings.active", { defaultValue: "Enabled" })})`
                          : ""
                      }`,
                    })),
                  ]}
                  value={chatProfileName}
                />
              </label>

              <ApiModelCombobox
                disabled={!petSettings || !chatConfig}
                error={chatModelsError}
                hasLoaded={chatModelsLoadedFor === chatConfig?.profileName}
                isLoading={chatModelsLoading}
                label={t("settings.petsChatModel", { defaultValue: "Model" })}
                loadingText={t("settings.loadingModels", {
                  defaultValue: "Loading models...",
                })}
                models={chatModels}
                noModelsText={t("chat.noModelsFound", {
                  defaultValue: "No models found",
                })}
                onChange={handlePetChatModelChange}
                onRequestModels={() => loadChatModels()}
                onRetry={() => loadChatModels(true)}
                placeholder={chatModelPlaceholder}
                retryText={t("common.retry", { defaultValue: "Retry" })}
                value={petSettings?.model ?? ""}
              />
            </div>
          </div>

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.petsInstalledSection", {
                  defaultValue: "Installed pets",
                })}
                <ApiSettingsHintIcon
                  hint={t("settings.petsInstalledInfo", {
                    defaultValue: "Select a pet to make it the active one.",
                  })}
                />
              </strong>
              <button
                className="api-settings-form-btn secondary"
                onClick={handleInstallPet}
                type="button"
                disabled={petInstalling}
              >
                {petInstalling ? (
                  <Loader2 size={14} strokeWidth={1.8} className="spin" />
                ) : (
                  <PackagePlus size={14} strokeWidth={1.8} />
                )}
                <span>
                  {petInstalling
                    ? t("settings.petsInstalling", {
                        defaultValue: "Installing pet...",
                      })
                    : t("settings.petsInstall", {
                        defaultValue: "Install pet package (.zip)",
                      })}
                </span>
              </button>
            </div>
            {pets.length === 0 ? (
              <div className="pets-empty">
                <PawPrint size={18} strokeWidth={1.6} />
                <span>
                  {t("settings.petsEmpty", {
                    defaultValue:
                      "No pets yet. Install a Codex pet package to get started.",
                  })}
                </span>
              </div>
            ) : (
              <div className="pets-list">
                {pets.map((pet) => {
                  const isActive = petSettings?.activePetId === pet.id;
                  const activeStateLabel = isActive
                    ? t("settings.active", { defaultValue: "Enabled" })
                    : t("settings.inactive", { defaultValue: "Not enabled" });
                  return (
                    <div
                      key={`${pet.source}:${pet.id}`}
                      className={`pets-list-item ${isActive ? "active" : ""}`}
                    >
                      <label
                        className="toggle-switch system-prompt-switch"
                        aria-label={activeStateLabel}
                        title={activeStateLabel}
                      >
                        <input
                          type="checkbox"
                          checked={isActive}
                          onChange={() => handleSelectPet(pet.id)}
                          disabled={!petSettings}
                          hidden
                        />
                        <span className="toggle-slider" />
                        <span>{activeStateLabel}</span>
                      </label>
                      <PetPreview spritesheetPath={pet.spritesheetPath} />
                      <span className="pets-list-info">
                        <span className="pets-list-name">
                          {pet.displayName}
                        </span>
                        <span className="pets-list-source">
                          {petSourceLabel(pet.source)}
                          {petSettings?.personas[pet.id]
                            ? ` · ${t("settings.petsPersonaCustomized", {
                                defaultValue: "Custom persona",
                              })}`
                            : ""}
                        </span>
                      </span>
                      <button
                        className="icon-btn ghost pets-persona-btn"
                        onClick={() => handleEditPersona(pet)}
                        type="button"
                        aria-label={t("settings.petsPersonaEdit", {
                          defaultValue: "Edit persona",
                        })}
                        title={t("settings.petsPersonaEdit", {
                          defaultValue: "Edit persona",
                        })}
                      >
                        <Pencil size={14} strokeWidth={1.8} />
                      </button>
                      {pet.source === "snow" && !pet.builtin && (
                        <button
                          className="icon-btn ghost danger pets-uninstall-btn"
                          onClick={() => handleUninstallPet(pet)}
                          type="button"
                          aria-label={t("settings.petsUninstall", {
                            defaultValue: "Uninstall",
                          })}
                        >
                          <Trash2 size={14} strokeWidth={1.8} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={petPendingDeletion !== null}
        title={t("settings.petsUninstallTitle", {
          defaultValue: "Uninstall pet",
        })}
        message={t("settings.petsUninstallConfirm", {
          values: { name: petPendingDeletion?.displayName ?? "" },
          defaultValue: 'Uninstall pet "{{name}}"?',
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={confirmUninstallPet}
        onCancel={() => setPetPendingDeletion(null)}
        variant="danger"
      />

      <PetPersonaDialog
        open={personaTarget !== null}
        petName={personaTarget?.displayName ?? ""}
        defaultPersona={personaTarget?.description ?? ""}
        value={personaDraft}
        isSaving={personaSaving}
        onChange={setPersonaDraft}
        onSave={handleSavePersona}
        onClose={handleClosePersona}
      />
    </div>
  );
}
