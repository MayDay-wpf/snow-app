/**
 * 文件图标的静态 HTML 版本（Markdown / 输入框 chip 用）。
 *
 * 与 fileIcons.tsx 分离：后者是纯映射 + React 组件，移动端也要复用它，
 * 不能把 react-dom/server 一起带进移动端产物。
 */
import { GitCommitHorizontal, GitCompare } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { getIconConfig } from "./fileIcons";

export const getFileTypeIconHtml = (
  name: string,
  isDirectory: boolean = false,
  isExpanded: boolean = false,
  size: number = 12,
): string => {
  const { component: IconComponent, color } = getIconConfig(
    name,
    isDirectory,
    isExpanded,
  );

  const style: React.CSSProperties = {};
  if (color) {
    style.color = color;
  }

  return renderToStaticMarkup(
    <IconComponent size={size} style={style} />,
  ).replace(/class="/g, 'class="file-chip-icon-inner ');
};

export const getCommitIconHtml = (size: number = 12): string => {
  return renderToStaticMarkup(
    <GitCommitHorizontal size={size} style={{ color: "#f05032" }} />,
  ).replace(/class="/g, 'class="file-chip-icon-inner ');
};

export const getChangeIconHtml = (size: number = 12): string => {
  return renderToStaticMarkup(
    <GitCompare size={size} style={{ color: "#f59e0b" }} />,
  ).replace(/class="/g, 'class="file-chip-icon-inner ');
};
