import { useCallback, useEffect, useState } from "react";

export const BROWSER_DEVICE_SIZE_SETTING_NAME = "Browser display size";
export const BROWSER_DEVICE_SIZE_SETTING_CODE = "browser_display_size";
export const DEFAULT_BROWSER_DEVICE_SIZE_ID = "default";

export type BrowserDeviceSizePreset = {
  id: string;
  /** 展示名（设备专有名词，不翻译） */
  label: string;
  /** CSS 逻辑像素宽 */
  width: number;
  /** CSS 逻辑像素高 */
  height: number;
};

/** 移动端调试用的设备视口预设（参考 Chrome DevTools Device Mode） */
export const BROWSER_DEVICE_SIZE_PRESETS: BrowserDeviceSizePreset[] = [
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
  { id: "iphone-15-pro", label: "iPhone 15 Pro", width: 393, height: 852 },
  { id: "iphone-15-pro-max", label: "iPhone 15 Pro Max", width: 430, height: 932 },
  { id: "pixel-7", label: "Pixel 7", width: 412, height: 915 },
  { id: "galaxy-s8", label: "Galaxy S8+", width: 360, height: 740 },
  { id: "ipad-mini", label: "iPad Mini", width: 768, height: 1024 },
  { id: "ipad-pro-11", label: 'iPad Pro 11"', width: 834, height: 1194 },
];

const BROWSER_DEVICE_SIZE_CHANGED_EVENT = "browser-device-size-changed";

// 模块级共享状态（同 useBrowserHomepage）：所有浏览器实例共用同一份
// 缓存与全局事件监听，多 tab / 独立窗口实例不会重复读库。
let cachedDeviceSizeId = DEFAULT_BROWSER_DEVICE_SIZE_ID;
let cachedLoaded = false;
let loadStarted = false;
let globalListenerAttached = false;
const subscribers = new Set<() => void>();

const notifySubscribers = (): void => {
  for (const subscriber of subscribers) {
    subscriber();
  }
};

const normalizeDeviceSizeId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_BROWSER_DEVICE_SIZE_ID;
  }
  const id = value.trim();
  const isKnown =
    id === DEFAULT_BROWSER_DEVICE_SIZE_ID ||
    BROWSER_DEVICE_SIZE_PRESETS.some((preset) => preset.id === id);
  return isKnown ? id : DEFAULT_BROWSER_DEVICE_SIZE_ID;
};

const readDeviceSizeJson = (value: string | null): string => {
  if (!value) {
    return DEFAULT_BROWSER_DEVICE_SIZE_ID;
  }
  try {
    return normalizeDeviceSizeId(JSON.parse(value));
  } catch {
    return DEFAULT_BROWSER_DEVICE_SIZE_ID;
  }
};

const loadDeviceSize = async (): Promise<void> => {
  try {
    const value = await window.snow.getSystemSettingValue(
      BROWSER_DEVICE_SIZE_SETTING_CODE
    );
    cachedDeviceSizeId = readDeviceSizeJson(value);
  } catch {
    cachedDeviceSizeId = DEFAULT_BROWSER_DEVICE_SIZE_ID;
  }
  cachedLoaded = true;
  notifySubscribers();
};

const ensureDeviceSizeLoaded = (): void => {
  if (!loadStarted) {
    loadStarted = true;
    void loadDeviceSize();
  }
  if (!globalListenerAttached) {
    globalListenerAttached = true;
    window.addEventListener(BROWSER_DEVICE_SIZE_CHANGED_EVENT, () => {
      void loadDeviceSize();
    });
  }
};

// 模块加载即预读并挂全局监听（主窗口 RightPanel 与独立浏览器窗口入口
// 均静态导入 BrowserPanelContent，随应用启动执行）。
ensureDeviceSizeLoaded();

/**
 * 浏览器显示尺寸（设备视口模拟）设置：持久化到系统设置库，
 * 全部实例共享同步，默认 "default" 表示不约束、占满内容区。
 */
export function useBrowserDeviceSize(): {
  deviceSizeId: string;
  setDeviceSize: (id: string) => Promise<void>;
} {
  const [, setVersion] = useState(0);

  useEffect(() => {
    ensureDeviceSizeLoaded();
    const subscriber = () => setVersion((version) => version + 1);
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  const setDeviceSize = useCallback(async (id: string) => {
    const normalized = normalizeDeviceSizeId(id);
    await window.snow.setSystemSetting(
      BROWSER_DEVICE_SIZE_SETTING_NAME,
      BROWSER_DEVICE_SIZE_SETTING_CODE,
      JSON.stringify(normalized)
    );
    // 立即更新共享缓存并通知所有实例，避免等全局事件回读数据库造成延迟。
    cachedDeviceSizeId = normalized;
    cachedLoaded = true;
    notifySubscribers();
    window.dispatchEvent(new Event(BROWSER_DEVICE_SIZE_CHANGED_EVENT));
  }, []);

  return { deviceSizeId: cachedDeviceSizeId, setDeviceSize };
}

/** 取激活预设（"default" 或未知 id 返回 null，表示不约束视口） */
export const findDeviceSizePreset = (
  id: string
): BrowserDeviceSizePreset | null =>
  BROWSER_DEVICE_SIZE_PRESETS.find((preset) => preset.id === id) ?? null;
