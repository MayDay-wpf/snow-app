import {
  Activity,
  BrainCircuit,
  ChevronsUp,
  CircleDot,
  CircleOff,
  Gauge,
  Rocket,
} from "lucide-react";
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
    { value: "none", label: "None", icon: CircleOff },
    { value: "low", label: "Low", icon: Gauge },
    { value: "medium", label: "Medium", icon: Activity },
    { value: "high", label: "High", icon: BrainCircuit },
    { value: "max", label: "Max", icon: Rocket },
  ],
  gemini: [
    { value: "none", label: "None", icon: CircleOff },
    { value: "minimal", label: "Minimal", icon: CircleDot },
    { value: "low", label: "Low", icon: Gauge },
    { value: "medium", label: "Medium", icon: Activity },
    { value: "high", label: "High", icon: BrainCircuit },
  ],
  interactions: [
    { value: "none", label: "None", icon: CircleOff },
    { value: "minimal", label: "Minimal", icon: CircleDot },
    { value: "low", label: "Low", icon: Gauge },
    { value: "medium", label: "Medium", icon: Activity },
    { value: "high", label: "High", icon: BrainCircuit },
  ],
  responses: [
    { value: "none", label: "None", icon: CircleOff },
    { value: "low", label: "Low", icon: Gauge },
    { value: "medium", label: "Medium", icon: Activity },
    { value: "high", label: "High", icon: BrainCircuit },
    { value: "xhigh", label: "Extra High", icon: ChevronsUp },
    { value: "max", label: "Max", icon: Rocket },
  ],
  chat: [
    { value: "none", label: "None", icon: CircleOff },
    { value: "low", label: "Low", icon: Gauge },
    { value: "medium", label: "Medium", icon: Activity },
    { value: "high", label: "High", icon: BrainCircuit },
    { value: "max", label: "Max", icon: Rocket },
  ],
};
