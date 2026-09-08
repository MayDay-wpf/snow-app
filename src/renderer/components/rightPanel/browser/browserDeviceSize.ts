import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// 浏览器「显示尺寸」设备目录与配置。
//
// 三份配置均持久化到系统设置库（Rust SQLite，经 settings:get/set-system-setting）：
//   - browser_display_size            当前选中的设备 id（"default" = 不约束）
//   - browser_display_devices_enabled 内置设备中显示在菜单里的 id 列表
//   - browser_display_devices_custom  自定义设备（视口 + 像素比 + UA 覆盖）
//
// 选中设备生效时分两层（见 BrowserPanelContent / main/browser/browserDeviceEmulation）：
//   - 宽高：webview 元素 CSS 尺寸约束（--device-size-width/height）；
//   - DPR / 移动端屏幕类型 / User-Agent：经 IPC 在主进程对 guest webContents
//     应用 enableDeviceEmulation + setUserAgent。
// ---------------------------------------------------------------------------

export const BROWSER_DEVICE_SIZE_SETTING_NAME = "Browser display size";
export const BROWSER_DEVICE_SIZE_SETTING_CODE = "browser_display_size";
export const BROWSER_DEVICE_ENABLED_SETTING_NAME =
  "Browser display devices enabled";
export const BROWSER_DEVICE_ENABLED_SETTING_CODE =
  "browser_display_devices_enabled";
export const BROWSER_DEVICE_CUSTOM_SETTING_NAME =
  "Browser display devices custom";
export const BROWSER_DEVICE_CUSTOM_SETTING_CODE =
  "browser_display_devices_custom";
export const DEFAULT_BROWSER_DEVICE_SIZE_ID = "default";

/** 设备的 User-Agent 来源：内置设备按平台/形态取标准 UA，自定义设备用显式字符串。 */
export type DeviceUaKind =
  | "ios-phone"
  | "ios-tablet"
  | "android-phone"
  | "android-tablet"
  | "none"
  | "custom";

export type BrowserDisplayDevice = {
  id: string;
  /** 展示名（设备专有名词，不翻译） */
  name: string;
  /** CSS 逻辑像素宽 */
  width: number;
  /** CSS 逻辑像素高 */
  height: number;
  /** 设备像素比（devicePixelRatio） */
  dpr: number;
  /** 移动端（影响主进程 screenPosition=mobile 的屏幕类型模拟） */
  mobile: boolean;
  uaKind: DeviceUaKind;
  /** uaKind === "custom" 时的显式 User-Agent 覆盖；空串 = 不覆盖 */
  ua: string;
};

export type CustomDeviceInput = {
  name: string;
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  ua: string;
};

type DeviceFormFactor = "phone" | "tablet" | "desktop";
type DevicePlatform = "ios" | "android" | "none";

type BuiltinDeviceSpec = {
  id: string;
  name: string;
  width: number;
  height: number;
  dpr: number;
  formFactor: DeviceFormFactor;
  platform: DevicePlatform;
};

const phone = (
  id: string,
  name: string,
  width: number,
  height: number,
  dpr: number,
  platform: DevicePlatform,
): BuiltinDeviceSpec => ({
  id,
  name,
  width,
  height,
  dpr,
  formFactor: "phone",
  platform,
});

const tablet = (
  id: string,
  name: string,
  width: number,
  height: number,
  dpr: number,
  platform: DevicePlatform,
): BuiltinDeviceSpec => ({
  id,
  name,
  width,
  height,
  dpr,
  formFactor: "tablet",
  platform,
});

const desktopDevice = (
  id: string,
  name: string,
  width: number,
  height: number,
  dpr: number,
): BuiltinDeviceSpec => ({
  id,
  name,
  width,
  height,
  dpr,
  formFactor: "desktop",
  platform: "none",
});

/**
 * 内置设备目录（视口/像素比数据对齐 Chrome DevTools Device Mode）。
 * 注意：iphone-se / iphone-15-pro / iphone-15-pro-max / pixel-7 / galaxy-s8 /
 * ipad-mini / ipad-pro-11 这批 id 与旧版预设保持一致，老用户已保存的选中项不受影响。
 */
const BUILTIN_DEVICE_SPECS: BuiltinDeviceSpec[] = [
  // ---- 手机 ----
  phone("iphone-se", "iPhone SE", 375, 667, 2, "ios"),
  phone("iphone-8", "iPhone 8", 375, 667, 2, "ios"),
  phone("iphone-8-plus", "iPhone 8 Plus", 414, 736, 3, "ios"),
  phone("iphone-xr", "iPhone XR", 414, 896, 2, "ios"),
  phone("iphone-12-pro", "iPhone 12 Pro", 390, 844, 3, "ios"),
  phone("iphone-13", "iPhone 13", 390, 844, 3, "ios"),
  phone("iphone-14", "iPhone 14", 390, 844, 3, "ios"),
  phone("iphone-14-plus", "iPhone 14 Plus", 428, 926, 3, "ios"),
  phone("iphone-14-pro", "iPhone 14 Pro", 393, 852, 3, "ios"),
  phone("iphone-14-pro-max", "iPhone 14 Pro Max", 430, 932, 3, "ios"),
  phone("iphone-15", "iPhone 15", 393, 852, 3, "ios"),
  phone("iphone-15-plus", "iPhone 15 Plus", 430, 932, 3, "ios"),
  phone("iphone-15-pro", "iPhone 15 Pro", 393, 852, 3, "ios"),
  phone("iphone-15-pro-max", "iPhone 15 Pro Max", 430, 932, 3, "ios"),
  phone("iphone-16", "iPhone 16", 393, 852, 3, "ios"),
  phone("iphone-16-plus", "iPhone 16 Plus", 430, 932, 3, "ios"),
  phone("iphone-16-pro", "iPhone 16 Pro", 402, 874, 3, "ios"),
  phone("iphone-16-pro-max", "iPhone 16 Pro Max", 440, 956, 3, "ios"),
  phone("iphone-16e", "iPhone 16e", 390, 844, 3, "ios"),
  phone("pixel-3", "Pixel 3", 393, 786, 2.75, "android"),
  phone("pixel-3-xl", "Pixel 3 XL", 412, 846, 3.5, "android"),
  phone("pixel-4", "Pixel 4", 353, 745, 3, "android"),
  phone("pixel-4a-5g", "Pixel 4a (5G)", 412, 892, 2.625, "android"),
  phone("pixel-5", "Pixel 5", 393, 851, 2.75, "android"),
  phone("pixel-6-pro", "Pixel 6 Pro", 412, 892, 3.5, "android"),
  phone("pixel-7", "Pixel 7", 412, 915, 2.625, "android"),
  phone("pixel-7-pro", "Pixel 7 Pro", 412, 892, 3.5, "android"),
  phone("pixel-8", "Pixel 8", 412, 915, 2.625, "android"),
  phone("pixel-8-pro", "Pixel 8 Pro", 448, 998, 3, "android"),
  phone("galaxy-s5", "Galaxy S5", 360, 640, 3, "android"),
  phone("galaxy-s8", "Galaxy S8+", 360, 740, 4, "android"),
  phone("galaxy-s20-ultra", "Galaxy S20 Ultra", 412, 915, 3.5, "android"),
  phone("galaxy-z-fold-5", "Galaxy Z Fold 5", 344, 882, 3, "android"),
  phone("galaxy-note-3", "Galaxy Note 3", 360, 640, 3, "android"),
  phone("blackberry-z30", "BlackBerry Z30", 360, 640, 2, "android"),
  phone("lg-optimus-l70", "LG Optimus L70", 384, 640, 1.25, "android"),
  phone("microsoft-lumia-550", "Microsoft Lumia 550", 640, 360, 2, "android"),
  phone("moto-g4", "Moto G4", 360, 640, 3, "android"),
  phone("nexus-4", "Nexus 4", 384, 640, 2, "android"),
  phone("nexus-5", "Nexus 5", 360, 640, 3, "android"),
  phone("nexus-5x", "Nexus 5X", 412, 732, 2.625, "android"),
  phone("nexus-6p", "Nexus 6P", 412, 732, 3.5, "android"),
  phone("nokia-n9", "Nokia N9", 480, 854, 1, "android"),
  // ---- 平板 ----
  tablet("ipad-mini", "iPad Mini", 768, 1024, 2, "ios"),
  tablet("ipad-air", "iPad Air", 820, 1180, 2, "ios"),
  tablet("ipad-pro-11", 'iPad Pro 11"', 834, 1194, 2, "ios"),
  tablet("ipad-pro-12-9", 'iPad Pro 12.9"', 1024, 1366, 2, "ios"),
  tablet("blackberry-playbook", "BlackBerry PlayBook", 600, 1024, 1, "none"),
  tablet("kindle-fire-hdx", "Kindle Fire HDX", 800, 1280, 2, "android"),
  tablet("nexus-7", "Nexus 7", 600, 960, 2, "android"),
  tablet("surface-duo", "Surface Duo", 540, 720, 2.5, "android"),
  // ---- 桌面/大屏 ----
  desktopDevice("laptop-mdpi", "Laptop MDPI", 1280, 800, 1),
  desktopDevice("laptop-hidpi", "Laptop HiDPI", 1440, 900, 2),
  desktopDevice("surface-pro", "Surface Pro", 912, 1368, 2),
  desktopDevice("nest-hub", "Nest Hub", 1024, 600, 2),
  desktopDevice("nest-hub-max", "Nest Hub Max", 1280, 800, 2),
];

const UA_BY_PLATFORM_FACTOR: Record<
  DevicePlatform,
  Record<DeviceFormFactor, string>
> = {
  ios: {
    phone:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    tablet:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    desktop: "",
  },
  android: {
    phone:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    tablet:
      "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    desktop: "",
  },
  none: { phone: "", tablet: "", desktop: "" },
};

const resolveSpecUaKind = (spec: BuiltinDeviceSpec): DeviceUaKind => {
  if (spec.platform === "none") {
    return "none";
  }
  return spec.formFactor === "tablet"
    ? `${spec.platform}-tablet`
    : `${spec.platform}-phone`;
};

const specToDevice = (spec: BuiltinDeviceSpec): BrowserDisplayDevice => ({
  id: spec.id,
  name: spec.name,
  width: spec.width,
  height: spec.height,
  dpr: spec.dpr,
  mobile: spec.formFactor !== "desktop",
  uaKind: resolveSpecUaKind(spec),
  ua: "",
});

/** 内置设备全量目录（菜单展示由「启用列表」控制，见 useBrowserDisplayDevices）。 */
export const BUILTIN_BROWSER_DEVICES: readonly BrowserDisplayDevice[] =
  BUILTIN_DEVICE_SPECS.map(specToDevice);

/** 默认在浏览器菜单中展示的内置设备（覆盖既有预设 + 常用新机型）。 */
export const DEFAULT_ENABLED_DEVICE_IDS: readonly string[] = [
  "iphone-se",
  "iphone-15-pro",
  "iphone-15-pro-max",
  "iphone-14",
  "iphone-14-pro",
  "iphone-16",
  "iphone-16-pro",
  "iphone-16-pro-max",
  "pixel-7",
  "pixel-7-pro",
  "pixel-8",
  "galaxy-s8",
  "galaxy-s20-ultra",
  "galaxy-z-fold-5",
  "ipad-mini",
  "ipad-air",
  "ipad-pro-11",
  "ipad-pro-12-9",
  "laptop-hidpi",
];

const BUILTIN_DEVICE_INDEX = new Map(
  BUILTIN_BROWSER_DEVICES.map((device) => [device.id, device]),
);

const UA_BY_KIND: Record<Exclude<DeviceUaKind, "none" | "custom">, string> = {
  "ios-phone": UA_BY_PLATFORM_FACTOR.ios.phone,
  "ios-tablet": UA_BY_PLATFORM_FACTOR.ios.tablet,
  "android-phone": UA_BY_PLATFORM_FACTOR.android.phone,
  "android-tablet": UA_BY_PLATFORM_FACTOR.android.tablet,
};

/** 解析设备的生效 User-Agent（空串 = 不覆盖，沿用应用默认 UA）。 */
export const resolveDeviceUserAgent = (
  device: BrowserDisplayDevice,
): string => {
  switch (device.uaKind) {
    case "ios-phone":
    case "ios-tablet":
    case "android-phone":
    case "android-tablet":
      return UA_BY_KIND[device.uaKind];
    case "custom":
      return device.ua;
    default:
      return "";
  }
};

// ---------------------------------------------------------------------------
// 模块级共享状态（同 useBrowserHomepage 模式）：所有浏览器实例共用同一份
// 缓存与全局事件监听，多 tab / 独立窗口实例不会重复读库。
// ---------------------------------------------------------------------------

type DeviceState = {
  selectedId: string;
  enabledIds: string[];
  customDevices: BrowserDisplayDevice[];
};

const BROWSER_DEVICE_SIZE_CHANGED_EVENT = "browser-device-size-changed";

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.round(value), min), max);

const sanitizeCustomDevices = (value: unknown): BrowserDisplayDevice[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const devices: BrowserDisplayDevice[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const name =
      typeof record.name === "string" ? record.name.trim().slice(0, 60) : "";
    const width = typeof record.width === "number" ? record.width : Number.NaN;
    const height =
      typeof record.height === "number" ? record.height : Number.NaN;
    const dpr = typeof record.dpr === "number" ? record.dpr : Number.NaN;
    if (
      !name ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      !Number.isFinite(dpr)
    ) {
      continue;
    }
    let id =
      typeof record.id === "string" && record.id.startsWith("custom-")
        ? record.id
        : "";
    while (!id || seen.has(id)) {
      id = `custom-${Math.random().toString(36).slice(2, 10)}`;
    }
    seen.add(id);
    devices.push({
      id,
      name,
      width: clampInt(width, 50, 4000),
      height: clampInt(height, 50, 4000),
      dpr: Math.min(Math.max(Math.round(dpr * 8) / 8, 1), 8),
      mobile: record.mobile !== false,
      uaKind: "custom",
      ua: typeof record.ua === "string" ? record.ua.slice(0, 512) : "",
    });
  }
  return devices;
};

const sanitizeEnabledIds = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    // 从未配置过：交给调用方回退到默认启用列表。
    return null;
  }
  const ids = value.filter(
    (id): id is string =>
      typeof id === "string" && BUILTIN_DEVICE_INDEX.has(id),
  );
  return [...new Set(ids)];
};

const readStateJson = (value: string | null): unknown => {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

let state: DeviceState = {
  selectedId: DEFAULT_BROWSER_DEVICE_SIZE_ID,
  enabledIds: [...DEFAULT_ENABLED_DEVICE_IDS],
  customDevices: [],
};
let loadStarted = false;
let globalListenerAttached = false;
const subscribers = new Set<() => void>();

const notifySubscribers = (): void => {
  for (const subscriber of subscribers) {
    subscriber();
  }
};

const normalizeDeviceId = (
  value: unknown,
  customDevices: BrowserDisplayDevice[],
): string => {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_BROWSER_DEVICE_SIZE_ID;
  }
  const id = value.trim();
  if (id === DEFAULT_BROWSER_DEVICE_SIZE_ID) {
    return id;
  }
  const isKnown =
    BUILTIN_DEVICE_INDEX.has(id) ||
    customDevices.some((device) => device.id === id);
  return isKnown ? id : DEFAULT_BROWSER_DEVICE_SIZE_ID;
};

const loadDeviceState = async (): Promise<void> => {
  let selectedId = DEFAULT_BROWSER_DEVICE_SIZE_ID;
  let enabledIds: string[] = [...DEFAULT_ENABLED_DEVICE_IDS];
  let customDevices: BrowserDisplayDevice[] = [];
  try {
    const [selectedRaw, enabledRaw, customRaw] = await Promise.all([
      window.snow.getSystemSettingValue(BROWSER_DEVICE_SIZE_SETTING_CODE),
      window.snow.getSystemSettingValue(BROWSER_DEVICE_ENABLED_SETTING_CODE),
      window.snow.getSystemSettingValue(BROWSER_DEVICE_CUSTOM_SETTING_CODE),
    ]);
    customDevices = sanitizeCustomDevices(readStateJson(customRaw));
    const enabled = sanitizeEnabledIds(readStateJson(enabledRaw));
    if (enabled !== null) {
      enabledIds = enabled;
    }
    selectedId = normalizeDeviceId(readStateJson(selectedRaw), customDevices);
  } catch {
    // 读取失败：保持默认值（不约束视口 + 默认启用列表）。
  }
  state = { selectedId, enabledIds, customDevices };
  notifySubscribers();
};

const ensureDeviceStateLoaded = (): void => {
  if (!loadStarted) {
    loadStarted = true;
    void loadDeviceState();
  }
  if (!globalListenerAttached) {
    globalListenerAttached = true;
    window.addEventListener(BROWSER_DEVICE_SIZE_CHANGED_EVENT, () => {
      void loadDeviceState();
    });
  }
};

// 模块加载即预读并挂全局监听（主窗口 RightPanel 与独立浏览器窗口入口
// 均静态导入 BrowserPanelContent，随应用启动执行）。
ensureDeviceStateLoaded();

const persistSetting = async (
  name: string,
  code: string,
  value: unknown,
): Promise<void> => {
  await window.snow.setSystemSetting(name, code, JSON.stringify(value));
};

/**
 * 浏览器显示尺寸设备配置：选中设备 + 菜单启用列表 + 自定义设备的读写。
 * 全部实例共享同步（模块级缓存 + 全局事件），数据经 Rust 设置库持久化。
 */
export function useBrowserDisplayDevices(): {
  /** 当前选中设备 id（"default" = 不约束，占满内容区） */
  selectedDeviceId: string;
  /** 当前选中设备（"default" 或未知 id 时为 null） */
  selectedDevice: BrowserDisplayDevice | null;
  /** 菜单展示的设备列表（启用的内置设备 + 全部自定义设备） */
  menuDevices: BrowserDisplayDevice[];
  builtinDevices: readonly BrowserDisplayDevice[];
  customDevices: readonly BrowserDisplayDevice[];
  enabledBuiltinIds: ReadonlySet<string>;
  setSelectedDevice: (id: string) => Promise<void>;
  setBuiltinEnabled: (id: string, enabled: boolean) => Promise<void>;
  addCustomDevice: (input: CustomDeviceInput) => Promise<BrowserDisplayDevice>;
  updateCustomDevice: (device: BrowserDisplayDevice) => Promise<void>;
  removeCustomDevice: (id: string) => Promise<void>;
} {
  const [, setVersion] = useState(0);

  useEffect(() => {
    ensureDeviceStateLoaded();
    const subscriber = () => setVersion((version) => version + 1);
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  const setSelectedDevice = useCallback(async (id: string) => {
    const normalized = normalizeDeviceId(id, state.customDevices);
    await persistSetting(
      BROWSER_DEVICE_SIZE_SETTING_NAME,
      BROWSER_DEVICE_SIZE_SETTING_CODE,
      normalized,
    );
    state = { ...state, selectedId: normalized };
    notifySubscribers();
    window.dispatchEvent(new Event(BROWSER_DEVICE_SIZE_CHANGED_EVENT));
  }, []);

  const setBuiltinEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      if (!BUILTIN_DEVICE_INDEX.has(id)) {
        return;
      }
      const current = new Set(state.enabledIds);
      if (enabled) {
        current.add(id);
      } else {
        current.delete(id);
      }
      const next = [...current];
      await persistSetting(
        BROWSER_DEVICE_ENABLED_SETTING_NAME,
        BROWSER_DEVICE_ENABLED_SETTING_CODE,
        next,
      );
      state = { ...state, enabledIds: next };
      notifySubscribers();
      window.dispatchEvent(new Event(BROWSER_DEVICE_SIZE_CHANGED_EVENT));
    },
    [],
  );

  const addCustomDevice = useCallback(
    async (input: CustomDeviceInput): Promise<BrowserDisplayDevice> => {
      const device: BrowserDisplayDevice = {
        id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: input.name,
        width: clampInt(input.width, 50, 4000),
        height: clampInt(input.height, 50, 4000),
        dpr: Math.min(Math.max(Math.round(input.dpr * 8) / 8, 1), 8),
        mobile: input.mobile,
        uaKind: "custom",
        ua: input.ua,
      };
      const next = [...state.customDevices, device];
      await persistSetting(
        BROWSER_DEVICE_CUSTOM_SETTING_NAME,
        BROWSER_DEVICE_CUSTOM_SETTING_CODE,
        next,
      );
      state = { ...state, customDevices: next };
      notifySubscribers();
      window.dispatchEvent(new Event(BROWSER_DEVICE_SIZE_CHANGED_EVENT));
      return device;
    },
    [],
  );

  const updateCustomDevice = useCallback(
    async (device: BrowserDisplayDevice): Promise<void> => {
      const next = state.customDevices.map((item) =>
        item.id === device.id
          ? {
              ...device,
              width: clampInt(device.width, 50, 4000),
              height: clampInt(device.height, 50, 4000),
              dpr: Math.min(Math.max(Math.round(device.dpr * 8) / 8, 1), 8),
              uaKind: "custom" as const,
            }
          : item,
      );
      await persistSetting(
        BROWSER_DEVICE_CUSTOM_SETTING_NAME,
        BROWSER_DEVICE_CUSTOM_SETTING_CODE,
        next,
      );
      state = { ...state, customDevices: next };
      notifySubscribers();
      window.dispatchEvent(new Event(BROWSER_DEVICE_SIZE_CHANGED_EVENT));
    },
    [],
  );

  const removeCustomDevice = useCallback(async (id: string): Promise<void> => {
    const next = state.customDevices.filter((device) => device.id !== id);
    await persistSetting(
      BROWSER_DEVICE_CUSTOM_SETTING_NAME,
      BROWSER_DEVICE_CUSTOM_SETTING_CODE,
      next,
    );
    // 删除的设备正在使用时回落到「默认」，避免悬挂引用。
    const selectedId =
      state.selectedId === id
        ? DEFAULT_BROWSER_DEVICE_SIZE_ID
        : state.selectedId;
    if (selectedId !== state.selectedId) {
      await persistSetting(
        BROWSER_DEVICE_SIZE_SETTING_NAME,
        BROWSER_DEVICE_SIZE_SETTING_CODE,
        selectedId,
      );
    }
    state = { selectedId, enabledIds: state.enabledIds, customDevices: next };
    notifySubscribers();
    window.dispatchEvent(new Event(BROWSER_DEVICE_SIZE_CHANGED_EVENT));
  }, []);

  const selectedDevice =
    state.selectedId === DEFAULT_BROWSER_DEVICE_SIZE_ID
      ? null
      : (BUILTIN_DEVICE_INDEX.get(state.selectedId) ??
        state.customDevices.find((device) => device.id === state.selectedId) ??
        null);

  const menuDevices: BrowserDisplayDevice[] = [
    ...BUILTIN_BROWSER_DEVICES.filter((device) =>
      state.enabledIds.includes(device.id),
    ),
    ...state.customDevices,
  ];

  return {
    selectedDeviceId: state.selectedId,
    selectedDevice,
    menuDevices,
    builtinDevices: BUILTIN_BROWSER_DEVICES,
    customDevices: state.customDevices,
    enabledBuiltinIds: new Set(state.enabledIds),
    setSelectedDevice,
    setBuiltinEnabled,
    addCustomDevice,
    updateCustomDevice,
    removeCustomDevice,
  };
}

/** 按 id 查找设备（内置 + 自定义缓存；"default" 返回 null）。 */
export const findDeviceById = (id: string): BrowserDisplayDevice | null => {
  if (id === DEFAULT_BROWSER_DEVICE_SIZE_ID) {
    return null;
  }
  return (
    BUILTIN_DEVICE_INDEX.get(id) ??
    state.customDevices.find((device) => device.id === id) ??
    null
  );
};
