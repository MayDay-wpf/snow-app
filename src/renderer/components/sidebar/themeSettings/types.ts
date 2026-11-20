export type ThemeMode = "system" | "light" | "dark";

/** 全局布局风格：孤岛（默认）、层叠（逐层覆盖）、平铺（贴边铺满、细线分隔）。 */
export type ThemeLayoutStyle = "island" | "layered" | "flush";

export type ThemePalette = {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
  bgActive: string;
  chromeBg: string;
  appBg: string;
  borderColor: string;
  borderLight: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textMuted: string;
  accentGreen: string;
  accentGreenBg: string;
  accentGreenText: string;
  accentRed: string;
  accentRedBg: string;
  accentRedText: string;
  accentBlue: string;
  accentBlueBg: string;
  accentBlueText: string;
  accentColor: string;
  onSolid: string;
  selectionBg: string;
  focusRing: string;
};

export type CustomTheme = {
  light: ThemePalette;
  dark: ThemePalette;
};

/** 背景来源：自定义图片 / 桌面宠物 idle 动画。 */
export type ThemeBackgroundSource = "image" | "pet";

/** 背景图片轮播的播放顺序。 */
export type ThemeCarouselOrder = "sequential" | "random";

export type ThemeBackground = {
  enabled: boolean;
  source: ThemeBackgroundSource;
  /** 背景图片列表（source 为 image 时生效，首张为初始显示图） */
  imagePaths: string[];
  /** 宠物背景使用的已安装宠物 id（source 为 pet 时生效） */
  petId: string;
  /** 宠物背景大小：相对视口高度的比例 */
  petScale: number;
  opacity: number;
  blur: number;
  /** 是否开启自动轮播（图片数量 >= 2 时生效） */
  carouselEnabled: boolean;
  /** 轮播切换间隔（秒），范围 10 ~ 7200 */
  carouselIntervalSecs: number;
  /** 轮播播放顺序：顺序 / 随机 */
  carouselOrder: ThemeCarouselOrder;
  /** 当前显示 / 固定的背景图路径（空表示取列表首张） */
  currentImagePath: string;
};

/**
 * 流式光标配置。iconType 决定渲染形态：
 * - "dot"：默认脉冲圆点
 * - "lucide"：使用内置 lucide 图标，由 lucideName 指定
 * - "custom"：使用用户上传的 SVG，由 svgPath 指定文件路径
 * - "snowbot"：内置 Snow Bot 动态机器人图标
 * - "image"：用户上传的任意图片（含 GIF），原样显示无动画，路径复用 svgPath
 * - "canvas"：用户上传的 JS 绘制脚本，Worker + OffscreenCanvas 运行，路径复用 svgPath
 */
export type ThemeStreamCursor = {
  iconType: "dot" | "lucide" | "custom" | "snowbot" | "image" | "canvas";
  lucideName: string;
  svgPath: string;
  iconSize: number;
};

/** 排版设置：界面字号（驱动整页缩放）+ 正文字重 + 聊天正文字号 / 行高 + 代码字号。 */
export type ThemeTypography = {
  fontSize: number;
  fontWeight: number;
  chatFontSize: number;
  chatLineHeight: number;
  codeFontSize: number;
};

/** IM 风格角色卡：AI 根据图片生成的角色设定（注入系统提示词）。 */
export type ThemeCharacterCard = {
  /** 启停开关；停用时保留卡片但不注入提示词。 */
  enabled: boolean;
  name: string;
  tagline: string;
  personality: string;
  speakingStyle: string;
  background: string;
  greeting: string;
};

/** 聊天窗口风格：IM 模式开关 + AI / 用户头像（空路径为默认头像）+ 角色卡。 */
export type ThemeChatStyle = {
  imMode: boolean;
  aiAvatarPath: string;
  userAvatarPath: string;
  characterCard: ThemeCharacterCard;
};

export type ThemeSettings = {
  mode: ThemeMode;
  presetId: string;
  layoutStyle: ThemeLayoutStyle;
  custom: CustomTheme;
  background: ThemeBackground;
  fontFamily: string;
  streamCursor: ThemeStreamCursor;
  typography: ThemeTypography;
  chatStyle: ThemeChatStyle;
};

export type ThemePreset = {
  id: string;
  nameKey: string;
  defaultName: string;
  light: ThemePalette;
  dark: ThemePalette;
};

export type ColorGroup = {
  titleKey: string;
  defaultTitle: string;
  roles: ColorRoleDefinition[];
};

export type ColorRoleDefinition = {
  role: keyof ThemePalette;
  labelKey: string;
  defaultLabel: string;
};
