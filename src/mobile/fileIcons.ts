/**
 * 移动端文件类型图标：复用 renderer/utils/fileIcons.tsx 的扩展名映射，
 * 把 React 图标组件转成静态 SVG 字符串（移动端不渲染 React 树）。
 *
 * 两个注意点：
 * - 颜色只能写成 SVG 表现属性（fill / stroke）：远控页 CSP 为 style-src 'self'，
 *   inline style 会被浏览器拦掉，PC 端的 style.color 做法在这里无效；
 * - 图标组件只取 path 数据、不挂载：brand 图标调用组件工厂拿 React 元素，
 *   lucide 图标通过 forwardRef.render 取 iconNode，结果按组件对象缓存。
 */
import type { ComponentType } from "react";
import {
  getIconConfig,
  type IconConfig,
  type IconKind,
} from "../renderer/utils/fileIcons";
import { ICONS } from "./icons";

type IconParts = {
  viewBox: string;
  inner: string;
  kind: IconKind;
};

type ElementLike = {
  type: unknown;
  props: Record<string, unknown>;
};

const CACHE_LIMIT = 512;
const markupCache = new Map<string, string>();
const partsCache = new WeakMap<object, IconParts | null>();

const escapeAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const attrName = (key: string): string =>
  key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);

const isElementLike = (value: unknown): value is ElementLike =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  "props" in value &&
  typeof (value as ElementLike).props === "object" &&
  (value as ElementLike).props !== null;

const serializeAttrs = (attrs: Record<string, unknown>): string => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "children" || key === "key" || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${attrName(key)}="${escapeAttr(String(value))}"`);
    }
  }
  return parts.join(" ");
};

/** React 元素树 → SVG 子节点字符串（只递归元素节点）。 */
const serializeChildren = (children: unknown): string => {
  if (
    children === null ||
    children === undefined ||
    typeof children === "boolean"
  )
    return "";
  if (Array.isArray(children)) return children.map(serializeChildren).join("");
  if (!isElementLike(children) || typeof children.type !== "string") return "";
  const attrs = serializeAttrs(children.props);
  const inner = serializeChildren(children.props.children);
  return `<${children.type}${attrs ? ` ${attrs}` : ""}>${inner}</${children.type}>`;
};

/** react-icons 图标：组件本身是工厂，直接调用得到 IconBase 元素。 */
const brandParts = (component: ComponentType<unknown>): IconParts | null => {
  const factory = component as unknown as (props: object) => unknown;
  const element = factory({});
  if (!isElementLike(element)) return null;
  const attr = element.props.attr;
  const viewBox =
    typeof attr === "object" &&
    attr !== null &&
    typeof (attr as { viewBox?: unknown }).viewBox === "string"
      ? (attr as { viewBox: string }).viewBox
      : "0 0 24 24";
  const inner = serializeChildren(element.props.children);
  return inner ? { viewBox, inner, kind: "brand" } : null;
};

/** lucide 图标：forwardRef 的 render 返回带 iconNode 的 Icon 元素。 */
const lucideParts = (component: ComponentType<unknown>): IconParts | null => {
  const forward = component as unknown as {
    render?: (props: object, ref: unknown) => unknown;
  };
  if (typeof forward.render !== "function") return null;
  const element = forward.render({}, null);
  if (!isElementLike(element) || !Array.isArray(element.props.iconNode)) {
    return null;
  }
  const inner = (element.props.iconNode as unknown[])
    .map((node) => {
      if (!Array.isArray(node) || typeof node[0] !== "string") return "";
      const attrs =
        typeof node[1] === "object" && node[1] !== null
          ? serializeAttrs(node[1] as Record<string, unknown>)
          : "";
      return `<${node[0]}${attrs ? ` ${attrs}` : ""}/>`;
    })
    .join("");
  return inner ? { viewBox: "0 0 24 24", inner, kind: "lucide" } : null;
};

const iconParts = (config: IconConfig): IconParts | null => {
  const key = config.component as unknown as object;
  if (partsCache.has(key)) return partsCache.get(key) ?? null;
  const parts =
    config.kind === "brand"
      ? brandParts(config.component as ComponentType<unknown>)
      : lucideParts(config.component as ComponentType<unknown>);
  partsCache.set(key, parts);
  return parts;
};

const renderSvg = (
  parts: IconParts,
  color: string | undefined,
  size: number,
): string => {
  const paint = escapeAttr(color ?? "currentColor");
  const head =
    `<svg class="file-icn" width="${size}" height="${size}" ` +
    `viewBox="${parts.viewBox}" aria-hidden="true"`;
  if (parts.kind === "brand") {
    return `${head} fill="${paint}">${parts.inner}</svg>`;
  }
  return (
    `${head} fill="none" stroke="${paint}" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${parts.inner}</svg>`
  );
};

const fallbackSvg = (size: number): string =>
  `<svg class="file-icn" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
  `fill="none" stroke="#6c757d" stroke-width="2" stroke-linecap="round" ` +
  `stroke-linejoin="round" aria-hidden="true">${ICONS.file}</svg>`;

export type FileIconOptions = {
  isDirectory?: boolean;
  isExpanded?: boolean;
  size?: number;
};

/** 文件名 / 路径 → 与 PC 资源管理器一致的文件类型图标 SVG。 */
export const getFileIconMarkup = (
  name: string,
  options?: FileIconOptions,
): string => {
  const isDirectory = options?.isDirectory === true;
  const isExpanded = options?.isExpanded === true;
  const rawSize = Math.floor(options?.size ?? 12);
  const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 12;
  const key = `${name}\u0000${isDirectory ? 1 : 0}${isExpanded ? 1 : 0}\u0000${size}`;
  const cached = markupCache.get(key);
  if (cached !== undefined) return cached;

  let markup: string;
  try {
    const config = getIconConfig(name, isDirectory, isExpanded);
    const parts = iconParts(config);
    markup = parts ? renderSvg(parts, config.color, size) : fallbackSvg(size);
  } catch {
    markup = fallbackSvg(size);
  }
  if (markupCache.size >= CACHE_LIMIT) markupCache.clear();
  markupCache.set(key, markup);
  return markup;
};

/** 文件图标元素（span 包一层，方便按位置加类名 / 尺寸）。 */
export const fileIconEl = (
  name: string,
  options?: FileIconOptions & { className?: string },
): HTMLSpanElement => {
  const span = document.createElement("span");
  span.className = options?.className ?? "file-ico";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = getFileIconMarkup(name, options);
  return span;
};
