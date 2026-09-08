import { useMemo, useState } from "react";
import {
  Check,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  Search,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import {
  useBrowserDisplayDevices,
  type BrowserDisplayDevice,
} from "../../rightPanel/browser/browserDeviceSize";

/**
 * 浏览器设置面板「显示尺寸设备」tab（参考 UserscriptsSection 的 tab 内容组件）：
 *  - 内置设备（对齐 Chrome DevTools Device Mode 目录）：勾选后显示在
 *    浏览器菜单「显示尺寸」子菜单里；
 *  - 自定义设备：名称 + 视口宽高 + 设备像素比 + User-Agent + 移动端/桌面，
 *    添加后同样进入菜单，选中时在主进程应用 DPR / 屏幕类型 / UA 模拟。
 * 侧栏菜单「自定义设备…」经 browser-devices view 直达本 tab。
 */

const DIM_MIN = 50;
const DIM_MAX = 4000;
const DPR_MIN = 1;
const DPR_MAX = 8;

type DeviceFormDraft = {
  name: string;
  width: string;
  height: string;
  dpr: string;
  ua: string;
  mobile: boolean;
};

const EMPTY_DRAFT: DeviceFormDraft = {
  name: "",
  width: "",
  height: "",
  dpr: "",
  ua: "",
  mobile: true,
};

const toDraft = (device: BrowserDisplayDevice): DeviceFormDraft => ({
  name: device.name,
  width: String(device.width),
  height: String(device.height),
  dpr: String(device.dpr),
  ua: device.ua,
  mobile: device.mobile,
});

const parseDimension = (value: string): number | null => {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= DIM_MIN && parsed <= DIM_MAX
    ? parsed
    : null;
};

const parseDpr = (value: string): number | null => {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= DPR_MIN && parsed <= DPR_MAX
    ? parsed
    : null;
};

export function DisplayDevicesSection(): React.JSX.Element {
  const { t } = useI18n();
  const {
    selectedDeviceId,
    builtinDevices,
    customDevices,
    enabledBuiltinIds,
    setBuiltinEnabled,
    addCustomDevice,
    updateCustomDevice,
    removeCustomDevice,
  } = useBrowserDisplayDevices();

  // ---- 表单（新增 / 行内编辑共用）----
  const [draft, setDraft] = useState<DeviceFormDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  // ---- 搜索（同时过滤内置与自定义设备）----
  const [searchQuery, setSearchQuery] = useState("");

  const filteredBuiltin = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return builtinDevices;
    }
    return builtinDevices.filter((device) =>
      device.name.toLowerCase().includes(query),
    );
  }, [builtinDevices, searchQuery]);

  const filteredCustom = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return customDevices;
    }
    return customDevices.filter((device) =>
      device.name.toLowerCase().includes(query),
    );
  }, [customDevices, searchQuery]);

  const startEdit = (device: BrowserDisplayDevice): void => {
    setEditingId(device.id);
    setDraft(toDraft(device));
    setFormError("");
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormError("");
  };

  const handleSave = async (): Promise<void> => {
    const name = draft.name.trim();
    const width = parseDimension(draft.width);
    const height = parseDimension(draft.height);
    const dpr = parseDpr(draft.dpr);
    if (!name || width === null || height === null || dpr === null) {
      setFormError(t("settings.browserDeviceInvalid"));
      return;
    }
    setSaving(true);
    try {
      const ua = draft.ua.trim();
      if (editingId) {
        const target = customDevices.find((device) => device.id === editingId);
        if (target) {
          await updateCustomDevice({
            ...target,
            name,
            width,
            height,
            dpr,
            mobile: draft.mobile,
            ua,
          });
        }
        setEditingId(null);
      } else {
        await addCustomDevice({
          name,
          width,
          height,
          dpr,
          mobile: draft.mobile,
          ua,
        });
      }
      setDraft(EMPTY_DRAFT);
      setFormError("");
    } catch {
      setFormError(t("settings.browserDeviceSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDraftKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleSave();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  };

  const updateDraft = (patch: Partial<DeviceFormDraft>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  return (
    <div className="browser-settings-section">
      <div className="api-settings-form-section-header">
        <span className="api-settings-form-section-title">
          {t("settings.browserDevicesTitle")}
        </span>
      </div>
      <div className="browser-settings-hint-row">
        <Smartphone size={13} strokeWidth={1.8} />
        <span>{t("settings.browserDevicesInfo")}</span>
      </div>

      {/* 自定义设备：新增 / 行内编辑表单 */}
      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>{t("settings.browserDevicesCustomTitle")}</strong>
          <span>{t("settings.browserDevicesCustomHint")}</span>
        </div>
        <div className="api-settings-form-body">
          <div className="browser-settings-device-add-row">
            <input
              type="text"
              className="browser-settings-device-add-input"
              value={draft.name}
              onChange={(e) => updateDraft({ name: e.target.value })}
              onKeyDown={handleDraftKeyDown}
              placeholder={t("settings.browserDeviceNamePlaceholder")}
              spellCheck={false}
            />
            <input
              type="number"
              className="browser-settings-device-add-input is-numeric"
              value={draft.width}
              onChange={(e) => updateDraft({ width: e.target.value })}
              onKeyDown={handleDraftKeyDown}
              placeholder={t("settings.browserDeviceWidth")}
              min={DIM_MIN}
              max={DIM_MAX}
              title={t("settings.browserDeviceWidth")}
              spellCheck={false}
            />
            <span className="browser-settings-device-add-sep">×</span>
            <input
              type="number"
              className="browser-settings-device-add-input is-numeric"
              value={draft.height}
              onChange={(e) => updateDraft({ height: e.target.value })}
              onKeyDown={handleDraftKeyDown}
              placeholder={t("settings.browserDeviceHeight")}
              min={DIM_MIN}
              max={DIM_MAX}
              title={t("settings.browserDeviceHeight")}
              spellCheck={false}
            />
            <input
              type="number"
              className="browser-settings-device-add-input is-numeric"
              value={draft.dpr}
              onChange={(e) => updateDraft({ dpr: e.target.value })}
              onKeyDown={handleDraftKeyDown}
              placeholder={t("settings.browserDeviceDpr")}
              min={DPR_MIN}
              max={DPR_MAX}
              step="0.25"
              title={t("settings.browserDeviceDprHint")}
              spellCheck={false}
            />
            <label className="browser-settings-device-toggle">
              <input
                type="checkbox"
                checked={draft.mobile}
                onChange={(e) => updateDraft({ mobile: e.target.checked })}
              />
              <span>
                {draft.mobile
                  ? t("settings.browserDeviceMobile")
                  : t("settings.browserDeviceDesktop")}
              </span>
            </label>
            <button
              type="button"
              className="browser-settings-device-save-btn"
              onClick={() => void handleSave()}
              disabled={saving}
              title={
                editingId ? t("common.save") : t("settings.browserDeviceAdd")
              }
            >
              {saving ? (
                <Loader2 size={13} strokeWidth={1.8} className="spin" />
              ) : editingId ? (
                <Check size={13} strokeWidth={2} />
              ) : (
                <Plus size={13} strokeWidth={2} />
              )}
              <span>
                {editingId ? t("common.save") : t("settings.browserDeviceAdd")}
              </span>
            </button>
            {editingId && (
              <button
                type="button"
                className="browser-settings-device-save-btn is-ghost"
                onClick={cancelEdit}
                title={t("common.cancel")}
              >
                <X size={13} strokeWidth={2} />
                <span>{t("common.cancel")}</span>
              </button>
            )}
          </div>
          <div className="browser-settings-device-add-row">
            <input
              type="text"
              className="browser-settings-device-add-input is-ua"
              value={draft.ua}
              onChange={(e) => updateDraft({ ua: e.target.value })}
              onKeyDown={handleDraftKeyDown}
              placeholder={t("settings.browserDeviceUaPlaceholder")}
              spellCheck={false}
            />
          </div>
          {formError && (
            <div className="browser-settings-device-error">{formError}</div>
          )}

          {customDevices.length === 0 ? (
            <div className="browser-settings-empty">
              {t("settings.browserDeviceCustomEmpty")}
            </div>
          ) : (
            <div className="browser-settings-table-wrap">
              <table className="browser-settings-table">
                <thead>
                  <tr>
                    <th>{t("settings.browserDeviceColName")}</th>
                    <th>{t("settings.browserDeviceColSize")}</th>
                    <th>{t("settings.browserDeviceColDpr")}</th>
                    <th>{t("settings.browserDeviceColType")}</th>
                    <th>{t("settings.browserDeviceColUa")}</th>
                    <th className="browser-settings-table-actions" />
                  </tr>
                </thead>
                <tbody>
                  {filteredCustom.map((device) => (
                    <tr
                      key={device.id}
                      className={
                        selectedDeviceId === device.id ? "is-selected" : ""
                      }
                    >
                      <td className="browser-settings-table-host">
                        {device.name}
                        {selectedDeviceId === device.id && (
                          <span className="browser-settings-device-badge is-active">
                            {t("settings.browserDeviceActive")}
                          </span>
                        )}
                      </td>
                      <td>
                        {device.width} × {device.height}
                      </td>
                      <td>{device.dpr}</td>
                      <td>
                        <span
                          className={`browser-settings-device-badge${
                            device.mobile ? "" : " is-desktop"
                          }`}
                        >
                          {device.mobile ? (
                            <Smartphone size={11} strokeWidth={1.8} />
                          ) : (
                            <Monitor size={11} strokeWidth={1.8} />
                          )}
                          {device.mobile
                            ? t("settings.browserDeviceMobile")
                            : t("settings.browserDeviceDesktop")}
                        </span>
                      </td>
                      <td className="browser-settings-device-ua-cell">
                        <span
                          title={
                            device.ua || t("settings.browserDeviceUaDefault")
                          }
                        >
                          {device.ua || t("settings.browserDeviceUaDefault")}
                        </span>
                      </td>
                      <td className="browser-settings-table-actions">
                        <button
                          type="button"
                          className="browser-settings-icon-btn"
                          onClick={() => startEdit(device)}
                          disabled={editingId === device.id}
                          aria-label={t("common.edit")}
                          title={t("common.edit")}
                        >
                          <Pencil size={14} strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          className="browser-settings-icon-btn is-danger"
                          onClick={() => void removeCustomDevice(device.id)}
                          aria-label={t("common.delete")}
                          title={t("common.delete")}
                        >
                          <Trash2 size={14} strokeWidth={1.8} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 内置设备：勾选控制是否显示在浏览器菜单中 */}
      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>{t("settings.browserDevicesBuiltinTitle")}</strong>
          <span>{t("settings.browserDevicesBuiltinHint")}</span>
        </div>
        <div className="api-settings-form-body">
          <div className="browser-settings-search-row">
            <Search size={13} strokeWidth={1.8} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("settings.browserDeviceSearchPlaceholder")}
              spellCheck={false}
            />
            {searchQuery && (
              <button
                type="button"
                className="browser-settings-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label={t("common.clear")}
                title={t("common.clear")}
              >
                <X size={13} strokeWidth={1.8} />
              </button>
            )}
            {searchQuery && (
              <span className="browser-settings-search-count">
                {filteredBuiltin.length}/{builtinDevices.length}
              </span>
            )}
          </div>

          {filteredBuiltin.length === 0 ? (
            <div className="browser-settings-empty">
              {t("settings.browserDeviceSearchEmpty")}
            </div>
          ) : (
            <div className="browser-settings-device-list">
              {filteredBuiltin.map((device) => {
                const isActive = selectedDeviceId === device.id;
                return (
                  <label
                    key={device.id}
                    className={`browser-settings-device-item${
                      isActive ? " is-active" : ""
                    }`}
                    title={`${device.name} · ${device.width}×${device.height} · DPR ${device.dpr}`}
                  >
                    <input
                      type="checkbox"
                      checked={enabledBuiltinIds.has(device.id)}
                      onChange={(e) =>
                        void setBuiltinEnabled(device.id, e.target.checked)
                      }
                    />
                    <span className="browser-settings-device-item-main">
                      <span className="browser-settings-device-item-name">
                        {device.name}
                        {isActive && (
                          <span className="browser-settings-device-badge is-active">
                            {t("settings.browserDeviceActive")}
                          </span>
                        )}
                      </span>
                      <span className="browser-settings-device-item-dims">
                        {device.width} × {device.height} · DPR {device.dpr} ·{" "}
                        {device.mobile
                          ? t("settings.browserDeviceMobile")
                          : t("settings.browserDeviceDesktop")}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
