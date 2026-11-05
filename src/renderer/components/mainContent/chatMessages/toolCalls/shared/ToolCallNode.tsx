import { ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../../../../i18n";
import { resolveLocalized } from "../../../../../plugins/manifest";
import { usePluginStore } from "../../../../../plugins/pluginStore";
import { usePluginToolOwner } from "../../../../../plugins/pluginToolIndex";
import { PluginIcon } from "../../../../common/PluginIcon";
import { resolveToolDisplayName } from "./toolDisplayName";
import type { ToolCategory } from "./ToolNameBadge";
import { ToolNameBadge } from "./ToolNameBadge";

type ToolCallNodeProps = {
  /** Raw MCP tool name (e.g. "filesystem-read") or short name. */
  toolName: string;
  /** Badge display name (e.g. "read", "edit"). Falls back to parsed short name. */
  badgeName?: string;
  /** Badge category. Inferred from toolName if omitted. */
  category?: ToolCategory;
  /** Context label shown after the badge (e.g. filename, command). Accepts ReactNode for rich content like file icons. */
  displayName?: ReactNode;
  /** Tooltip text for the displayName area. Only used when displayName is set. */
  displayNameTitle?: string;
  /** 显式文件路径；提供后 displayName 支持 Ctrl+点击打开。 */
  displayNameDataPath?: string;
  /** Current status of the tool call. */
  status: "pending" | "running" | "completed" | "error";
  /** Whether the node is expanded by default. */
  defaultOpen?: boolean;
  /** Extra metadata rendered inline in the header (badges, counts, etc.). */
  meta?: ReactNode;
  /** Additional CSS class on the outer <details>. */
  className?: string;
  /**
   * 收起时不渲染 body（展开时才挂载），用于昂贵的子内容（如 diff 视图），
   * 节省资源；代价是收起会卸载 body 内部状态。
   */
  lazyBody?: boolean;
  /** Body content shown when expanded. */
  children?: ReactNode;
};

export const ToolCallNode = ({
  toolName,
  badgeName,
  category,
  displayName,
  displayNameTitle,
  displayNameDataPath,
  status,
  defaultOpen = false,
  meta,
  className,
  lazyBody,
  children,
}: ToolCallNodeProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  // 工具归属：工具全名反查所属工具插件，命中时在标题旁标注来源插件。
  const ownerPluginId = usePluginToolOwner(toolName);
  const plugins = usePluginStore();
  const ownerPlugin = ownerPluginId
    ? (plugins.plugins.find((plugin) => plugin.pluginId === ownerPluginId) ??
      null)
    : null;
  const [isOpen, setIsOpen] = useState(defaultOpen);
  // 收起动画进行中：保留 open 直到退场动画结束，再真正折叠
  const [isClosing, setIsClosing] = useState(false);
  const isRunning = status === "running";

  // When defaultOpen changes from false to true (e.g. an interactive
  // session starts), automatically expand the node so the body — and
  // therefore the interactive input area — becomes visible without the
  // user having to click the summary manually.
  useEffect(() => {
    if (defaultOpen) {
      setIsOpen(true);
    }
  }, [defaultOpen]);

  // Resolve the badge name: explicit badgeName wins; otherwise look up the
  // tool name in the i18n `toolNames` table (e.g. "browser-create" → "创建浏览器",
  // "anysearch-extract" → "网页提取"); finally fall back to the readable short
  // name so external MCP tools never show a raw `batch_search` token.
  const resolvedBadgeName = badgeName || resolveToolDisplayName(t, toolName);

  const dotClass =
    status === "completed"
      ? "tcn-dot--completed"
      : status === "running"
        ? "tcn-dot--running"
        : status === "error"
          ? "tcn-dot--error"
          : "tcn-dot--pending";

  // 接管 summary 开合：展开立即生效；收起先播镜像退场动画（tcn--closing），
  // 动画结束才移除 open —— 原生 details 去 open 会瞬时隐藏，无法播退场动画。
  const handleSummaryClick = (e: React.MouseEvent<HTMLElement>): void => {
    if (!children) {
      return; // 无 body 时无可动画内容，保持原生瞬时开合
    }
    e.preventDefault();
    if (isClosing) {
      return; // 收起动画期间忽略重复点击，避免打断
    }
    if (!isOpen) {
      setIsOpen(true);
    } else if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // 减弱动态偏好下 CSS 动画被禁用（animationend 不会触发），直接折叠
      setIsOpen(false);
    } else {
      setIsClosing(true);
    }
  };

  // 退场动画结束后才真正折叠（animationend 会冒泡，需按动画名过滤）
  const handleBodyAnimationEnd = (
    e: React.AnimationEvent<HTMLDivElement>,
  ): void => {
    if (e.animationName === "tcn-body-out") {
      setIsClosing(false);
      setIsOpen(false);
    }
  };

  return (
    <details
      className={`tcn tcn--${status}${isClosing ? " tcn--closing" : ""}${
        className ? ` ${className}` : ""
      }`}
      open={isOpen}
      onToggle={(e) => setIsOpen(e.currentTarget.open)}
    >
      <summary className="tcn-header" onClick={handleSummaryClick}>
        <span className={`tcn-dot ${dotClass}`} aria-hidden="true" />
        {ownerPlugin && (
          <span
            className="tool-call-plugin-origin"
            title={
              ownerPlugin.description
                ? `${ownerPlugin.pluginId}\n${resolveLocalized(ownerPlugin.description, locale) || ""}`.trim()
                : ownerPlugin.pluginId
            }
          >
            <PluginIcon
              icon={ownerPlugin.icon}
              pluginId={ownerPlugin.pluginId}
              size={12}
              className="tool-call-plugin-origin-icon"
            />
            <span className="tool-call-plugin-origin-name">
              {resolveLocalized(ownerPlugin.name, locale) ||
                ownerPlugin.pluginId}
            </span>
          </span>
        )}
        <ToolNameBadge name={resolvedBadgeName} category={category} />
        {displayName ? (
          <>
            <span className="tcn-sep" aria-hidden="true">
              /
            </span>
            <span
              className="tcn-name"
              title={displayNameTitle}
              data-path={displayNameDataPath}
            >
              {displayName}
            </span>
          </>
        ) : isRunning ? (
          // 参数还在流式到达（半截 JSON 解析失败）或没有可摘要字段时，
          // header 至少告知用户该工具正在执行，避免只见徽章不知道在调什么。
          <>
            <span className="tcn-sep" aria-hidden="true">
              /
            </span>
            <span className="tcn-name tcn-name--running">
              {t("toolCall.common.status.running", {
                defaultValue: "Running",
              })}
            </span>
          </>
        ) : status === "pending" ? (
          // pending（尚未开始执行）且没有可摘要字段时同样给占位文案，
          // 避免 header 只剩徽章光秃秃的（参数流式到达后会被真实摘要替换）。
          <>
            <span className="tcn-sep" aria-hidden="true">
              /
            </span>
            <span className="tcn-name tcn-name--running">
              {t("toolCall.common.status.pending", {
                defaultValue: "Pending",
              })}
            </span>
          </>
        ) : null}
        {meta ? <span className="tcn-meta">{meta}</span> : null}
        <ChevronRight className="tcn-chevron" size={12} aria-hidden="true" />
      </summary>
      {/* 外层 grid 容器负责高度镜像动画（0fr<->1fr），内层 body 只负责
          淡入淡出+位移；padding 留在内层，0fr 时不残留高度。 */}
      {children && (lazyBody ? isOpen : true) ? (
        <div className="tcn-collapse">
          <div className="tcn-body" onAnimationEnd={handleBodyAnimationEnd}>
            {children}
          </div>
        </div>
      ) : null}
    </details>
  );
};
