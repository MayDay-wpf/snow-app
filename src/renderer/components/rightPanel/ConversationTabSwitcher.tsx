import { Check, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { renderStatusIcon } from "../sidebar/mainSidebar/SubAgentListPanel";
import { renderNodeIcon } from "../sidebar/mainSidebar/WorkflowNodeListPanel";
import {
  hasConversationTabChildren,
  useConversationTabTree,
  type ConversationTabTreeNode,
} from "./useConversationTabTree";

/** 下拉菜单宽度（与 .conversation-tab-switcher-menu 的宽度一致）。 */
const MENU_WIDTH = 220;
/** 菜单与视口边缘的最小间距。 */
const MENU_MARGIN = 8;

type ConversationTabSwitcherProps = {
  /** 拖入面板的根会话（tab 身份）。 */
  rootConversationId: string;
  /** 当前展示的会话 id（缺省 = 根会话）。 */
  viewConversationId: string;
  /** tab 标题（树数据未就绪时先显示它，避免标题闪空）。 */
  title: string;
  /** 切换到某个会话：由 RightPanel 改写 tab 的展示会话与标题。 */
  onSelect: (conversationId: string, title: string) => void;
};

/**
 * 会话 tab 的标题下拉：会话被拖进右侧面板后，把它的子代理与 Workflow 节点
 * （以及节点下派生的子代理）一并带过来，可在同一个面板内直接切换查看，
 * 无需为每个子会话再开一个 tab。
 *
 * 层级与侧边栏会话树一致：根会话 →（子代理）/（Workflow 节点 → 子代理），
 * 节点行悬停或点箭头即展开下一层。没有任何子会话时退化为普通标题，
 * 与其它 tab 标题完全一致。
 */
export function ConversationTabSwitcher({
  rootConversationId,
  viewConversationId,
  title,
  onSelect,
}: ConversationTabSwitcherProps): React.JSX.Element {
  const { t } = useI18n();
  const { attentionRequiredConversationIds } = useChatConversationContext();
  const tree = useConversationTabTree(rootConversationId);
  const hasChildren = hasConversationTabChildren(tree);
  /** 当前展示的会话 id（缺省 = 根会话）。 */
  const activeViewId = viewConversationId || rootConversationId;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{
    left: number;
    top: number;
  } | null>(null);
  // 已展开子代理层的 Workflow 节点（单层展开：悬停或点箭头切换）。
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const isMenuOpen = menuAnchor !== null;

  const closeMenu = useCallback((): void => {
    setMenuAnchor(null);
    setExpandedNodeId(null);
  }, []);

  const toggleMenu = (): void => {
    if (isMenuOpen) {
      closeMenu();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    // 打开时若当前展示的是某个 Workflow 节点下的子代理，直接展开该节点层，
    // 让「当前选中项」可见。
    const ownerNode = tree?.workflowNodes.find((node) =>
      node.children.some((child) => child.conversationId === activeViewId),
    );
    setExpandedNodeId(ownerNode?.conversationId ?? null);
    setMenuAnchor({
      left: Math.max(
        MENU_MARGIN,
        Math.min(rect.left, window.innerWidth - MENU_WIDTH - MENU_MARGIN),
      ),
      top: rect.bottom + 4,
    });
  };

  // 点击外部 / Esc / 窗口尺寸变化时收起（菜单位置按视口坐标计算，尺寸变化后失效）。
  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (
        target &&
        (triggerRef.current?.contains(target) ||
          menuRef.current?.contains(target))
      ) {
        return;
      }
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeMenu);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeMenu);
    };
  }, [isMenuOpen, closeMenu]);

  const isAttentionRequired = (node: ConversationTabTreeNode): boolean =>
    node.status === "waiting_input" ||
    attentionRequiredConversationIds.has(node.conversationId) ||
    node.children.some(
      (child) =>
        child.status === "waiting_input" ||
        attentionRequiredConversationIds.has(child.conversationId),
    );

  const resolveLabel = (node: ConversationTabTreeNode): string => {
    if (node.label) {
      return node.label;
    }
    if (node.kind === "workflow-node") {
      return t("sidebar.workflowNode", { defaultValue: "Workflow node" });
    }
    if (node.kind === "sub-agent") {
      return t("sidebar.subAgent", { defaultValue: "Sub-agent" });
    }
    return t("sidebar.untitledChat", { defaultValue: "Untitled" });
  };

  const handleSelect = (node: ConversationTabTreeNode): void => {
    closeMenu();
    onSelect(node.conversationId, node.label);
  };

  /** 会话项（根会话 / 子代理 / Workflow 节点共用）。 */
  const renderEntry = (
    node: ConversationTabTreeNode,
    isCurrent: boolean,
    label: string,
  ): React.ReactNode => (
    <button
      type="button"
      role="menuitem"
      className={`conversation-tab-switcher-item${isCurrent ? " active" : ""}`}
      title={label}
      onClick={() => handleSelect(node)}
    >
      <span className="conversation-tab-switcher-icon">
        {node.kind === "root" ? (
          <MessageSquare size={11} aria-hidden="true" />
        ) : node.kind === "workflow-node" ? (
          renderNodeIcon(node.status, isAttentionRequired(node))
        ) : (
          renderStatusIcon(node.status, isAttentionRequired(node))
        )}
      </span>
      <span className="conversation-tab-switcher-name">{label}</span>
      {isCurrent ? (
        <Check
          size={12}
          className="conversation-tab-switcher-check"
          aria-hidden="true"
        />
      ) : null}
    </button>
  );

  /** Workflow 节点行：右侧箭头展开其子代理（下一层），与节点选择互不干扰。 */
  const renderNodeRow = (node: ConversationTabTreeNode): React.ReactNode => {
    const hasChildNodes = node.children.length > 0;
    const isExpanded = expandedNodeId === node.conversationId;
    const label = resolveLabel(node);
    return (
      <div
        key={node.conversationId}
        className="conversation-tab-switcher-node"
        onMouseEnter={() => {
          if (hasChildNodes) {
            setExpandedNodeId(node.conversationId);
          }
        }}
      >
        <div className="conversation-tab-switcher-row">
          {renderEntry(node, node.conversationId === activeViewId, label)}
          {hasChildNodes ? (
            <button
              type="button"
              className="conversation-tab-switcher-expand"
              aria-expanded={isExpanded}
              aria-label={t("rightPanel.conversationTabGroupSubAgents", {
                defaultValue: "Sub-agents",
              })}
              onClick={() =>
                setExpandedNodeId(isExpanded ? null : node.conversationId)
              }
            >
              <ChevronRight
                size={11}
                className={isExpanded ? "expanded" : ""}
                aria-hidden="true"
              />
            </button>
          ) : null}
        </div>
        {hasChildNodes && isExpanded ? (
          <div className="conversation-tab-switcher-children">
            {node.children.map((child) =>
              renderEntry(
                child,
                child.conversationId === activeViewId,
                resolveLabel(child),
              ),
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {hasChildren && tree ? (
        <button
          ref={triggerRef}
          type="button"
          className="conversation-tab-switcher-trigger"
          title={title}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          onClick={toggleMenu}
        >
          <span className="conversation-tab-switcher-label">{title}</span>
          <ChevronDown
            size={11}
            className={`conversation-tab-switcher-caret${
              isMenuOpen ? " expanded" : ""
            }`}
            aria-hidden="true"
          />
        </button>
      ) : (
        <span className="right-panel-tab-title" title={title}>
          {title}
        </span>
      )}
      {isMenuOpen && menuAnchor && tree
        ? createPortal(
            <div
              ref={menuRef}
              className="conversation-tab-switcher-menu"
              role="menu"
              style={{ left: menuAnchor.left, top: menuAnchor.top }}
            >
              {renderEntry(
                tree.root,
                tree.root.conversationId === activeViewId,
                resolveLabel(tree.root),
              )}
              {tree.subAgents.length > 0 ? (
                <>
                  <div className="conversation-tab-switcher-group">
                    {t("rightPanel.conversationTabGroupSubAgents", {
                      defaultValue: "Sub-agents",
                    })}
                  </div>
                  {tree.subAgents.map((node) =>
                    renderEntry(
                      node,
                      node.conversationId === activeViewId,
                      resolveLabel(node),
                    ),
                  )}
                </>
              ) : null}
              {tree.workflowNodes.length > 0 ? (
                <>
                  <div className="conversation-tab-switcher-group">
                    {t("rightPanel.conversationTabGroupWorkflowNodes", {
                      defaultValue: "Workflow nodes",
                    })}
                  </div>
                  {tree.workflowNodes.map(renderNodeRow)}
                </>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
