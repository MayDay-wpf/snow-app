import {
  ThinkingHighIcon,
  ThinkingLowIcon,
  ThinkingMaxIcon,
  ThinkingMediumIcon,
  ThinkingMinimalIcon,
  ThinkingNoneIcon,
  ThinkingXHighIcon,
} from "./thinkingIcons";
import type { RequestMethod, ThinkingOption } from "./types";

export const MAX_TEXTAREA_ROWS = 8;
export const DEFAULT_TEXTAREA_ROWS = 2;
export const DEFAULT_THINKING_VALUE = "high";

/**
 * 粘贴大段文本时的阈值（字符数）。超出此值的纯文本粘贴会被
 * 标签化为 text-snippet chip，避免 contenteditable 输入框渲染
 * 海量文本节点导致整个应用卡死。
 */
export const TEXT_SNIPPET_THRESHOLD = 2000;

export const THINKING_OPTIONS_BY_METHOD: Record<
  RequestMethod,
  ThinkingOption[]
> = {
  anthropic: [
    { value: "none", label: "None", icon: ThinkingNoneIcon },
    { value: "low", label: "Low", icon: ThinkingLowIcon },
    { value: "medium", label: "Medium", icon: ThinkingMediumIcon },
    { value: "high", label: "High", icon: ThinkingHighIcon },
    { value: "max", label: "Max", icon: ThinkingMaxIcon },
  ],
  gemini: [
    { value: "none", label: "None", icon: ThinkingNoneIcon },
    { value: "minimal", label: "Minimal", icon: ThinkingMinimalIcon },
    { value: "low", label: "Low", icon: ThinkingLowIcon },
    { value: "medium", label: "Medium", icon: ThinkingMediumIcon },
    { value: "high", label: "High", icon: ThinkingHighIcon },
  ],
  interactions: [
    { value: "none", label: "None", icon: ThinkingNoneIcon },
    { value: "minimal", label: "Minimal", icon: ThinkingMinimalIcon },
    { value: "low", label: "Low", icon: ThinkingLowIcon },
    { value: "medium", label: "Medium", icon: ThinkingMediumIcon },
    { value: "high", label: "High", icon: ThinkingHighIcon },
  ],
  responses: [
    { value: "none", label: "None", icon: ThinkingNoneIcon },
    { value: "low", label: "Low", icon: ThinkingLowIcon },
    { value: "medium", label: "Medium", icon: ThinkingMediumIcon },
    { value: "high", label: "High", icon: ThinkingHighIcon },
    { value: "xhigh", label: "Extra High", icon: ThinkingXHighIcon },
    { value: "max", label: "Max", icon: ThinkingMaxIcon },
  ],
  chat: [
    { value: "none", label: "None", icon: ThinkingNoneIcon },
    { value: "low", label: "Low", icon: ThinkingLowIcon },
    { value: "medium", label: "Medium", icon: ThinkingMediumIcon },
    { value: "high", label: "High", icon: ThinkingHighIcon },
    { value: "max", label: "Max", icon: ThinkingMaxIcon },
  ],
};
