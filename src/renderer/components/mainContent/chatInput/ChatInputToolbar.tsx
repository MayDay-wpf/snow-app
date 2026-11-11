import {
  Command,
  Feather,
  GitBranch,
  ShieldAlert,
  Target,
  Workflow,
} from "lucide-react";
import type { ComponentProps, RefObject } from "react";
import { useI18n } from "../../../i18n";
import { Tooltip } from "../../common/Tooltip";
import { ChatInputPluginButtons } from "./ChatInputPluginButtons";
import { splitDraftText } from "./fileTagUtils";
import { ModelSelector } from "./ModelSelector";
import { PlusMenu, type PlusMenuSection } from "./PlusMenu";
import { TokenUsageRing } from "./TokenUsageRing";
import { WorktreeSessionSelector } from "./WorktreeSessionSelector";
import { ChatInputActionButtons } from "./ChatInputActionButtons";
import { LspStatusBadge } from "./LspStatusBadge";
import type { ChatInputViewProps } from "./types";

type ChatInputToolbarProps = ComponentProps<typeof ModelSelector> &
  Pick<
    ChatInputViewProps,
    | "projectId"
    | "value"
    | "tokenUsage"
    | "isAborting"
    | "isCompacting"
    | "handleAbort"
    | "handleSend"
    | "sendKeyMode"
    | "setSendKeyMode"
    | "yoloMode"
    | "isUpdatingYoloMode"
    | "onYoloModeChange"
    | "onRefreshYoloMode"
    | "liteMode"
    | "isUpdatingLiteMode"
    | "onLiteModeChange"
    | "onRefreshLiteMode"
    | "goalMode"
    | "isUpdatingGoalMode"
    | "onGoalModeChange"
    | "onRefreshGoalMode"
    | "worktreeMode"
    | "isUpdatingWorktreeMode"
    | "onWorktreeModeChange"
    | "onRefreshWorktreeMode"
    | "workflowMode"
    | "isUpdatingWorkflowMode"
    | "onWorkflowModeChange"
    | "onRefreshWorkflowMode"
    | "goalModeTokenBudget"
    | "onGoalModeTokenBudgetChange"
    | "autoFormatEnabled"
    | "onAutoFormatChange"
    | "onRefreshAutoFormat"
    | "toolCorrectionEnabled"
    | "onToolCorrectionChange"
    | "onRefreshToolCorrection"
    | "contextFoldEnabled"
    | "onContextFoldChange"
    | "onRefreshContextFold"
  > & {
    plusMenuSections: PlusMenuSection[];
    commandTriggerRef: RefObject<HTMLButtonElement | null>;
    isCommandOpen: boolean;
    handleToggleCommand: () => void;
    /** 打开输入区 WorkFlow 手动编排器弹窗。 */
    onOpenWorkflowComposer?: () => void;
    sessionKey?: string;
    conversationId?: string | null;
  };

export const ChatInputToolbar = ({
  projectId,
  sessionKey,
  conversationId,
  plusMenuSections,
  commandTriggerRef,
  isCommandOpen,
  handleToggleCommand,
  onOpenWorkflowComposer,
  value,
  tokenUsage,
  isAborting,
  isCompacting,
  handleAbort,
  handleSend,
  sendKeyMode,
  setSendKeyMode,
  ...modelSelectorProps
}: ChatInputToolbarProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    yoloMode,
    isUpdatingYoloMode,
    onYoloModeChange,
    onRefreshYoloMode,
    liteMode,
    isUpdatingLiteMode,
    onLiteModeChange,
    onRefreshLiteMode,
    goalMode,
    isUpdatingGoalMode,
    onGoalModeChange,
    onRefreshGoalMode,
    worktreeMode,
    isUpdatingWorktreeMode,
    onWorktreeModeChange,
    onRefreshWorktreeMode,
    workflowMode,
    isUpdatingWorkflowMode,
    onWorkflowModeChange,
    onRefreshWorkflowMode,
    goalModeTokenBudget,
    onGoalModeTokenBudgetChange,
    autoFormatEnabled,
    onAutoFormatChange,
    onRefreshAutoFormat,
    toolCorrectionEnabled,
    onToolCorrectionChange,
    onRefreshToolCorrection,
    contextFoldEnabled,
    onContextFoldChange,
    onRefreshContextFold,
    isSubAgentConversation,
    isStreaming,
    runtimeApiConfig,
    isLoadingApiConfig,
  } = modelSelectorProps;

  const isSessionRunning = isStreaming || isAborting || isCompacting;

  return (
    <div className="input-toolbar">
      <div className="toolbar-left">
        <LspStatusBadge
          projectId={projectId}
          onOpenSettings={
            modelSelectorProps.onNavigateToView
              ? () => modelSelectorProps.onNavigateToView?.("lsp-settings")
              : undefined
          }
        />
        <PlusMenu
          sections={plusMenuSections}
          modesLocked={isSessionRunning}
          yoloMode={yoloMode}
          isUpdatingYoloMode={isUpdatingYoloMode}
          onYoloModeChange={onYoloModeChange}
          onRefreshYoloMode={onRefreshYoloMode}
          liteMode={liteMode}
          isUpdatingLiteMode={isUpdatingLiteMode}
          onLiteModeChange={onLiteModeChange}
          onRefreshLiteMode={onRefreshLiteMode}
          goalMode={goalMode}
          isUpdatingGoalMode={isUpdatingGoalMode}
          onGoalModeChange={
            isSubAgentConversation ? undefined : onGoalModeChange
          }
          onRefreshGoalMode={onRefreshGoalMode}
          worktreeMode={worktreeMode}
          isUpdatingWorktreeMode={isUpdatingWorktreeMode}
          onWorktreeModeChange={
            isSubAgentConversation ? undefined : onWorktreeModeChange
          }
          onRefreshWorktreeMode={onRefreshWorktreeMode}
          workflowMode={workflowMode}
          isUpdatingWorkflowMode={isUpdatingWorkflowMode}
          onWorkflowModeChange={
            isSubAgentConversation ? undefined : onWorkflowModeChange
          }
          onRefreshWorkflowMode={onRefreshWorkflowMode}
          goalModeTokenBudget={goalModeTokenBudget}
          onGoalModeTokenBudgetChange={
            isSubAgentConversation ? undefined : onGoalModeTokenBudgetChange
          }
          autoFormatEnabled={autoFormatEnabled}
          onAutoFormatChange={onAutoFormatChange}
          onRefreshAutoFormat={onRefreshAutoFormat}
          toolCorrectionEnabled={toolCorrectionEnabled}
          onToolCorrectionChange={onToolCorrectionChange}
          onRefreshToolCorrection={onRefreshToolCorrection}
          contextFoldEnabled={contextFoldEnabled}
          onContextFoldChange={onContextFoldChange}
          onRefreshContextFold={onRefreshContextFold}
        />
        <WorktreeSessionSelector />
        <button
          ref={commandTriggerRef}
          className={`toolbar-btn command-trigger${
            isCommandOpen ? " is-active" : ""
          }`}
          aria-label={t("chatCommand.trigger")}
          aria-expanded={isCommandOpen}
          onClick={handleToggleCommand}
          type="button"
          title={t("chatCommand.trigger")}
        >
          <Command size={15} />
        </button>
        {(goalMode || worktreeMode || yoloMode || liteMode || workflowMode) && (
          <span className="toolbar-divider" aria-hidden="true" />
        )}
        {goalMode && (
          <Tooltip content={t("plusMenu.goalModeDescription")}>
            <span
              className="mode-badge"
              aria-label={t("plusMenu.goalModeDescription")}
            >
              <Target size={14} />
            </span>
          </Tooltip>
        )}
        {worktreeMode && (
          <Tooltip content={t("plusMenu.worktreeModeDescription")}>
            <span
              className="mode-badge"
              aria-label={t("plusMenu.worktreeModeDescription")}
            >
              <GitBranch size={14} />
            </span>
          </Tooltip>
        )}
        {/* WorkFlow 模式开启时才提供手动编排入口：复用原 WorkFlow 模式徽标的位置，
            按钮本身即模式指示（原静态徽标已移除）。 */}
        {workflowMode && (
          <Tooltip content={t("workflowComposer.tooltip")}>
            <button
              className="toolbar-btn workflow-composer-trigger"
              aria-label={t("workflowComposer.tooltip")}
              disabled={isSubAgentConversation}
              onClick={onOpenWorkflowComposer}
              type="button"
            >
              <Workflow size={15} />
            </button>
          </Tooltip>
        )}
        {yoloMode && (
          <Tooltip content={t("plusMenu.yoloModeActive")}>
            <span
              className="mode-badge yolo-mode-badge"
              aria-label={t("plusMenu.yoloModeActive")}
            >
              <ShieldAlert size={14} />
            </span>
          </Tooltip>
        )}
        {liteMode && (
          <Tooltip content={t("plusMenu.liteModeActive")}>
            <span
              className="mode-badge lite-mode-badge"
              aria-label={t("plusMenu.liteModeActive")}
            >
              <Feather size={14} />
            </span>
          </Tooltip>
        )}
      </div>
      <div className="toolbar-right">
        <ChatInputPluginButtons
          sessionKey={sessionKey}
          conversationId={conversationId}
          parametersKey={JSON.stringify([
            modelSelectorProps.selectedApiProfile,
            modelSelectorProps.selectedModel,
            modelSelectorProps.thinkingValue,
            modelSelectorProps.responsesFastMode,
          ])}
          apiConfigIdentity={runtimeApiConfig}
          disabled={
            isLoadingApiConfig ||
            !runtimeApiConfig ||
            modelSelectorProps.apiConfigs.length === 0 ||
            !splitDraftText(value).text.trim()
          }
        />
        <ModelSelector {...modelSelectorProps} />
        <TokenUsageRing
          tokenUsage={tokenUsage}
          maxContextTokens={runtimeApiConfig?.maxContextTokens ?? null}
          isLoading={isLoadingApiConfig}
        />
        <ChatInputActionButtons
          value={value}
          isStreaming={isStreaming}
          isAborting={isAborting}
          apiConfigs={modelSelectorProps.apiConfigs}
          runtimeApiConfig={runtimeApiConfig}
          handleAbort={handleAbort}
          handleSend={handleSend}
          sendKeyMode={sendKeyMode}
          setSendKeyMode={setSendKeyMode}
        />
      </div>
    </div>
  );
};
