/**
 * 桌面宠物独立设置页。
 *
 * 与其它设置页保持一致的结构：页头（标题 + 描述 + 关闭按钮）+
 * api-settings-manual-form 表单卡片（分区：当前宠物、已安装宠物列表）。
 * 支持：唤醒/收起、安装 Codex 宠物包（.zip）、选择激活宠物、
 * 卸载 Snow App 安装的宠物、调整显示大小。
 */
import { Loader2, PackagePlus, PawPrint, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import type { PetManifest, PetSettings } from "../../../preload/types/pets";
import { PetPreview } from "../pet/PetPreview";
import { ConfirmDialog } from "../common/ConfirmDialog";

type PetsSettingsPanelProps = {
  onClose?: () => void;
};

export function PetsSettingsPanel({
  onClose,
}: PetsSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();

  const [pets, setPets] = useState<PetManifest[]>([]);
  const [petSettings, setPetSettings] = useState<PetSettings | null>(null);
  const [petInstalling, setPetInstalling] = useState(false);
  const [petInstallError, setPetInstallError] = useState<string | null>(null);
  const [petScaleDraft, setPetScaleDraft] = useState<number | null>(null);
  const [petPendingDeletion, setPetPendingDeletion] =
    useState<PetManifest | null>(null);
  const petScaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadPets = (): Promise<void> =>
    Promise.all([window.snow.listInstalledPets(), window.snow.getPetSettings()])
      .then(([petList, settings]) => {
        setPets(petList);
        setPetSettings(settings);
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

  const hasPets = pets.length > 0;
  const petEnabled = hasPets && (petSettings?.enabled ?? false);

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
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>{t("settings.pets", { defaultValue: "Desktop pet" })}</strong>
          <span className="settings-item-description">
            {t("settings.petsInfo", {
              defaultValue:
                "Install Codex pet packages (.zip) and let a desktop companion react to your AI work in real time.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.petsClose", {
              defaultValue: "Close pet settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      {petInstallError && (
        <span className="settings-update-error">{petInstallError}</span>
      )}

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.petsManageTitle", { defaultValue: "Manage pets" })}
          </strong>
          <span>
            {t("settings.petsManageInfo", {
              defaultValue:
                "Wake or dismiss the pet, adjust its size, and pick the active pet.",
            })}
          </span>
        </div>

        <div className="api-settings-form-body">
          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.petsActiveSection", {
                  defaultValue: "Active pet",
                })}
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
            <span className="settings-item-description">
              {t("settings.petsActiveInfo", {
                defaultValue: "Show or hide the desktop pet on your screen.",
              })}
            </span>
            {petEnabled && (
              <div className="pets-scale-row">
                <span className="settings-item-description">
                  {t("settings.petsScale", { defaultValue: "Size" })}
                </span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={petScaleDraft ?? petSettings?.scale ?? 0.75}
                  onChange={(event) =>
                    handlePetScaleChange(Number(event.target.value))
                  }
                  aria-label={t("settings.petsScale", {
                    defaultValue: "Size",
                  })}
                />
              </div>
            )}
          </div>

          <div className="api-settings-form-section">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.petsInstalledSection", {
                  defaultValue: "Installed pets",
                })}
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
            <span className="settings-item-description">
              {t("settings.petsInstalledInfo", {
                defaultValue: "Select a pet to make it the active one.",
              })}
            </span>
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
                        </span>
                      </span>
                      {pet.source === "snow" && (
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
    </div>
  );
}
