import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  GripVertical,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import {
  DISABLED_STATUS_LABEL,
  ENABLED_STATUS_LABEL,
} from "./apiSettingsConstants";
import { filterApiConfigs } from "./apiSettingsSearch";
import {
  useApiConfigReorder,
  API_CONFIG_ROW_ATTRIBUTE,
} from "./apiConfigReorder";
import type { ApiConfigItem } from "./types";

type ApiSettingsTableProps = {
  configs: ApiConfigItem[];
  isLoading: boolean;
  isBusy: boolean;
  onDuplicate: (config: ApiConfigItem) => void;
  onEdit: (config: ApiConfigItem) => void;
  onDelete: (profileName: string, displayName: string) => void;
  onToggleActive: (config: ApiConfigItem) => void;
  /** 导出选中的配置为迁移文件（含明文密钥）。 */
  onExportSelected: (profileNames: string[]) => void;
  /** 删除选中的配置。 */
  onDeleteSelected: (profileNames: string[]) => void;
  /** 拖拽或上移下移后的完整档案名顺序；由父组件负责落库。 */
  onReorder: (orderedProfileNames: string[]) => void;
};

export function ApiSettingsTable({
  configs,
  isLoading,
  isBusy,
  onDuplicate,
  onEdit,
  onDelete,
  onToggleActive,
  onExportSelected,
  onDeleteSelected,
  onReorder,
}: ApiSettingsTableProps): React.JSX.Element {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [pendingDeletion, setPendingDeletion] = useState<
    ApiConfigItem[] | null
  >(null);
  const filteredConfigs = useMemo(
    () => filterApiConfigs(configs, searchQuery),
    [configs, searchQuery],
  );
  const allProfileNames = useMemo(
    () => configs.map((config) => config.profileName),
    [configs],
  );
  const visibleProfileNames = useMemo(
    () => filteredConfigs.map((config) => config.profileName),
    [filteredConfigs],
  );
  const reorder = useApiConfigReorder({
    allNames: allProfileNames,
    visibleNames: visibleProfileNames,
    onReorder,
  });
  const hasSearchQuery = searchQuery.trim().length > 0;

  // 配置列表变化（删除、导入、同步）后丢弃已不存在的选中项。
  useEffect(() => {
    setSelectedNames((previous) => {
      const available = new Set(configs.map((config) => config.profileName));
      const next = previous.filter((name) => available.has(name));
      return next.length === previous.length ? previous : next;
    });
  }, [configs]);

  const selectedNameSet = useMemo(
    () => new Set(selectedNames),
    [selectedNames],
  );
  const selectedCount = selectedNames.length;
  const isAllFilteredSelected =
    filteredConfigs.length > 0 &&
    filteredConfigs.every((config) => selectedNameSet.has(config.profileName));
  const isPartiallySelected =
    !isAllFilteredSelected &&
    filteredConfigs.some((config) => selectedNameSet.has(config.profileName));

  const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  };

  const toggleSelection = (profileName: string) => {
    setSelectedNames((previous) =>
      previous.includes(profileName)
        ? previous.filter((name) => name !== profileName)
        : [...previous, profileName],
    );
  };

  const toggleSelectAll = () => {
    const filteredNames = filteredConfigs.map((config) => config.profileName);
    setSelectedNames((previous) => {
      const everySelected =
        filteredNames.length > 0 &&
        filteredNames.every((name) => previous.includes(name));
      return everySelected
        ? previous.filter((name) => !filteredNames.includes(name))
        : Array.from(new Set([...previous, ...filteredNames]));
    });
  };

  return (
    <div
      className="api-settings-table-panel"
      aria-label={t("settings.apiConfigTable", {
        defaultValue: "API configuration table",
      })}
    >
      <div className="api-settings-table-toolbar">
        <label className="api-settings-table-search">
          <Search size={14} strokeWidth={1.8} aria-hidden="true" />
          <input
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder={t("settings.apiSearchPlaceholder", {
              defaultValue: "Search profiles, models, or base URLs",
            })}
            aria-label={t("settings.apiSearchLabel", {
              defaultValue: "Search API profiles",
            })}
            disabled={isLoading && configs.length === 0}
          />
        </label>
      </div>

      {selectedCount > 0 && (
        <div className="api-settings-selection-bar">
          <span>
            {t("settings.apiSelectedCount", {
              defaultValue: "{count} selected",
            }).replace("{count}", String(selectedCount))}
          </span>
          <div className="api-settings-selection-bar-actions">
            <button
              className="api-settings-action-btn primary"
              onClick={() => onExportSelected(selectedNames)}
              type="button"
              disabled={isBusy}
            >
              <Upload size={14} strokeWidth={1.8} />
              <span>
                {t("settings.apiExportSelected", {
                  defaultValue: "Export selected",
                })}
              </span>
            </button>
            <button
              className="api-settings-action-btn danger"
              onClick={() =>
                setPendingDeletion(
                  configs.filter((config) =>
                    selectedNameSet.has(config.profileName),
                  ),
                )
              }
              type="button"
              disabled={isBusy}
            >
              <Trash2 size={14} strokeWidth={1.8} />
              <span>
                {t("settings.apiDeleteSelected", {
                  defaultValue: "Delete selected",
                })}
              </span>
            </button>
            <button
              className="icon-btn ghost"
              onClick={() => setSelectedNames([])}
              type="button"
              title={t("settings.clearSelection", {
                defaultValue: "Clear selection",
              })}
              aria-label={t("settings.clearSelection", {
                defaultValue: "Clear selection",
              })}
            >
              <X size={13} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      )}

      <div className="api-settings-table-wrap">
        {isLoading && configs.length === 0 ? (
          <div className="api-settings-empty">
            <Loader2 size={16} className="spin" />
            {t("settings.loadingApiConfigs", {
              defaultValue: "Loading API configs...",
            })}
          </div>
        ) : configs.length === 0 ? (
          <div className="api-settings-empty">
            {t("settings.noApiConfigs", {
              defaultValue:
                "No API profiles yet. Import Snow CLI profiles or add one manually.",
            })}
          </div>
        ) : filteredConfigs.length === 0 ? (
          <div className="api-settings-empty">
            {t("settings.noApiSearchResults", {
              defaultValue: "No API profiles match your search.",
            })}
          </div>
        ) : (
          <table className="api-settings-table">
            <thead>
              <tr>
                <th className="api-settings-table-order" />
                <th className="api-settings-table-select">
                  <input
                    type="checkbox"
                    checked={isAllFilteredSelected}
                    ref={(element) => {
                      if (element) {
                        element.indeterminate = isPartiallySelected;
                      }
                    }}
                    onChange={toggleSelectAll}
                    title={t("settings.apiSelectAll", {
                      defaultValue: "Select all",
                    })}
                    aria-label={t("settings.apiSelectAll", {
                      defaultValue: "Select all",
                    })}
                  />
                </th>
                <th>{t("settings.tableStatus", { defaultValue: "Status" })}</th>
                <th>{t("settings.tableName", { defaultValue: "Name" })}</th>
                <th>
                  {t("settings.tableBaseUrl", { defaultValue: "Base URL" })}
                </th>
                <th>{t("settings.tableModel", { defaultValue: "Model" })}</th>
                <th>{t("settings.tableMethod", { defaultValue: "Method" })}</th>
                <th className="api-settings-table-actions-col">
                  {t("settings.tableActions", { defaultValue: "Actions" })}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredConfigs.map((config) => {
                const activeStateLabel = config.isActive
                  ? t("settings.active", {
                      defaultValue: ENABLED_STATUS_LABEL,
                    })
                  : t("settings.inactive", {
                      defaultValue: DISABLED_STATUS_LABEL,
                    });
                const activeActionLabel = config.isActive
                  ? t("settings.activeProfile", {
                      defaultValue: "Enabled profile",
                    })
                  : t("settings.clickToActivate", {
                      defaultValue: "Set as default profile",
                    });
                const isSelected = selectedNameSet.has(config.profileName);

                const isDragging = reorder.draggingName === config.profileName;
                const isDropTarget =
                  reorder.dropTargetName === config.profileName;
                const rowClassName = [
                  isSelected && "is-selected",
                  isDragging && "is-dragging",
                  isDropTarget &&
                    (reorder.dropPlacement === "before"
                      ? "is-drop-before"
                      : "is-drop-after"),
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <tr
                    key={config.profileName}
                    {...reorder.getDropTargetProps(config.profileName)}
                    {...{ [API_CONFIG_ROW_ATTRIBUTE]: config.profileName }}
                    className={rowClassName || undefined}
                  >
                    <td className="api-settings-table-order">
                      <span
                        className="api-settings-drag-handle"
                        {...reorder.getDragHandleProps(config.profileName)}
                        title={t("settings.apiDragToReorder", {
                          defaultValue: "Drag to reorder",
                        })}
                      >
                        <GripVertical size={13} strokeWidth={1.8} />
                      </span>
                    </td>
                    <td className="api-settings-table-select">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelection(config.profileName)}
                        aria-label={t("settings.apiSelectProfile", {
                          defaultValue: "Select {name}",
                        }).replace("{name}", config.displayName)}
                      />
                    </td>
                    <td>
                      <label
                        className="toggle-switch api-settings-table-switch"
                        title={activeActionLabel}
                        aria-label={activeActionLabel}
                      >
                        <input
                          type="checkbox"
                          checked={config.isActive}
                          onChange={() => onToggleActive(config)}
                        />
                        <span className="toggle-slider" />
                        <span>{activeStateLabel}</span>
                      </label>
                    </td>
                    <td className="cell-name">
                      <button
                        className="cell-name-button"
                        onClick={() => onEdit(config)}
                        type="button"
                        title={t("settings.edit", { defaultValue: "Edit" })}
                        aria-label={t("settings.apiEditProfile", {
                          defaultValue: "Edit {name}",
                        }).replace("{name}", config.displayName)}
                      >
                        <strong>{config.displayName}</strong>
                        <small className="profile-name-hint">
                          {config.profileName}
                        </small>
                      </button>
                    </td>
                    <td className="cell-url">{config.baseUrl || "-"}</td>
                    <td>{config.advancedModel || config.basicModel || "-"}</td>
                    <td>
                      <span className="badge method">
                        {config.requestMethod}
                      </span>
                    </td>
                    <td className="api-settings-table-actions-col">
                      <div className="api-settings-table-actions">
                        <button
                          className="icon-btn ghost"
                          onClick={() => reorder.moveUp(config.profileName)}
                          disabled={!reorder.canMoveUp(config.profileName)}
                          type="button"
                          title={t("settings.apiMoveUp", {
                            defaultValue: "Move up",
                          })}
                          aria-label={t("settings.apiMoveUp", {
                            defaultValue: "Move up",
                          })}
                        >
                          <ChevronUp size={13} strokeWidth={1.8} />
                        </button>
                        <button
                          className="icon-btn ghost"
                          onClick={() => reorder.moveDown(config.profileName)}
                          disabled={!reorder.canMoveDown(config.profileName)}
                          type="button"
                          title={t("settings.apiMoveDown", {
                            defaultValue: "Move down",
                          })}
                          aria-label={t("settings.apiMoveDown", {
                            defaultValue: "Move down",
                          })}
                        >
                          <ChevronDown size={13} strokeWidth={1.8} />
                        </button>
                        <button
                          className="icon-btn ghost"
                          onClick={() => onDuplicate(config)}
                          type="button"
                          title={t("settings.duplicate", {
                            defaultValue: "Duplicate",
                          })}
                          aria-label={t("settings.duplicate", {
                            defaultValue: "Duplicate",
                          })}
                        >
                          <Copy size={13} strokeWidth={1.8} />
                        </button>
                        <button
                          className="icon-btn ghost"
                          onClick={() => onEdit(config)}
                          type="button"
                          title={t("settings.edit", { defaultValue: "Edit" })}
                          aria-label={t("settings.edit", {
                            defaultValue: "Edit",
                          })}
                        >
                          <Pencil size={13} strokeWidth={1.8} />
                        </button>
                        <button
                          className="icon-btn ghost danger"
                          onClick={() => setPendingDeletion([config])}
                          type="button"
                          title={t("settings.delete", {
                            defaultValue: "Delete",
                          })}
                          aria-label={t("settings.delete", {
                            defaultValue: "Delete",
                          })}
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {hasSearchQuery && filteredConfigs.length > 0 && (
        <span className="api-settings-search-count">
          {t("settings.apiSearchResultCount", {
            defaultValue: "{count} profile(s) found",
          }).replace("{count}", String(filteredConfigs.length))}
        </span>
      )}

      <ConfirmDialog
        open={pendingDeletion !== null}
        title={
          pendingDeletion && pendingDeletion.length > 1
            ? t("settings.apiDeleteSelectedTitle", {
                defaultValue: "Delete API profiles",
              })
            : t("settings.apiDeleteTitle", {
                defaultValue: "Delete API profile",
              })
        }
        message={
          pendingDeletion && pendingDeletion.length > 1
            ? t("settings.apiDeleteSelectedConfirm", {
                defaultValue: `Delete ${pendingDeletion.length} API profiles? This cannot be undone.`,
              })
            : t("settings.apiDeleteConfirm", {
                defaultValue: `Delete API profile "${
                  pendingDeletion?.[0]?.displayName ?? ""
                }"? This cannot be undone.`,
                values: { name: pendingDeletion?.[0]?.displayName ?? "" },
              })
        }
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => {
          if (pendingDeletion && pendingDeletion.length > 0) {
            if (pendingDeletion.length === 1) {
              const [config] = pendingDeletion;
              onDelete(config.profileName, config.displayName);
            } else {
              onDeleteSelected(
                pendingDeletion.map((config) => config.profileName),
              );
            }
          }
          setPendingDeletion(null);
        }}
        onCancel={() => setPendingDeletion(null)}
        variant="danger"
      />
    </div>
  );
}
