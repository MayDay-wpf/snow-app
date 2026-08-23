import {
  ClipboardList,
  Command,
  GitBranch,
  ShieldAlert,
  Target,
} from "lucide-react";
import type { ComponentProps, RefObject } from "react";
import { useI18n } from "../../../i18n";
import { Tooltip } from "../../common/Tooltip";
import { ModelSelector } from "./ModelSelector";
import { PlusMenu, type PlusMenuSection } from "./PlusMenu";
import { TokenUsageRing } from "./TokenUsageRing";
import { ChatInputActionButtons } from "./ChatInputActionButtons";
import type { ChatInputViewProps } from "./types";

type ChatInputToolbarProps = ComponentProps<typeof ModelSelector> &
  Pick<
    ChatInputViewProps,
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
    | "planMode"
    | "isUpdatingPlanMode"
    | "onPlanModeChange"
    | "onRefreshPlanMode"
    | "goalMode"
    | "isUpdatingGoalMode"
    | "onGoalModeChange"
    | "onRefreshGoalMode"
    | "worktreeMode"
    | "isUpdatingWorktreeMode"
    | "onWorktreeModeChange"
    | "onRefreshWorktreeMode"
    | "goalModeTokenBudget"
    | "onGoalModeTokenBudgetChange"
    | "autoScrollEnabled"
    | "onAutoScrollChange"
    | "autoFormatEnabled"
    | "onAutoFormatChange"
    | "onRefreshAutoFormat"
  > & {
    plusMenuSections: PlusMenuSection[];
    commandTriggerRef: RefObject<HTMLButtonElement | null>;
    isCommandOpen: boolean;
    handleToggleCommand: () => void;
  };

export const ChatInputToolbar = ({
  plusMenuSections,
  commandTriggerRef,
  isCommandOpen,
  handleToggleCommand,
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
    planMode,
    isUpdatingPlanMode,
    onPlanModeChange,
    onRefreshPlanMode,
    goalMode,
    isUpdatingGoalMode,
    onGoalModeChange,
    onRefreshGoalMode,
    worktreeMode,
    isUpdatingWorktreeMode,
    onWorktreeModeChange,
    onRefreshWorktreeMode,
    goalModeTokenBudget,
    onGoalModeTokenBudgetChange,
    autoScrollEnabled,
    onAutoScrollChange,
    autoFormatEnabled,
    onAutoFormatChange,
    onRefreshAutoFormat,
    isSubAgentConversation,
    isStreaming,
    runtimeApiConfig,
    isLoadingApiConfig,
  } = modelSelectorProps;

  return (
    <div className="input-toolbar">
      <div className="toolbar-left">
        <PlusMenu
          sections={plusMenuSections}
          yoloMode={yoloMode}
          isUpdatingYoloMode={isUpdatingYoloMode}
          onYoloModeChange={onYoloModeChange}
          onRefreshYoloMode={onRefreshYoloMode}
          planMode={planMode}
          isUpdatingPlanMode={isUpdatingPlanMode}
          onPlanModeChange={
            isSubAgentConversation ? undefined : onPlanModeChange
          }
          onRefreshPlanMode={onRefreshPlanMode}
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
          goalModeTokenBudget={goalModeTokenBudget}
          onGoalModeTokenBudgetChange={
            isSubAgentConversation ? undefined : onGoalModeTokenBudgetChange
          }
          autoScrollEnabled={autoScrollEnabled}
          onAutoScrollChange={onAutoScrollChange}
          autoFormatEnabled={autoFormatEnabled}
          onAutoFormatChange={onAutoFormatChange}
          onRefreshAutoFormat={onRefreshAutoFormat}
        />
        {value.trim() === "" && (
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
        )}
        {planMode && (
          <>
            <span className="toolbar-divider" aria-hidden="true" />
            <span
              className="plan-mode-badge"
              title={t("plusMenu.planModeActive")}
            >
              <ClipboardList size={14} />
            </span>
          </>
        )}
        {goalMode && (
          <>
            <span className="toolbar-divider" aria-hidden="true" />
            <span
              className="plan-mode-badge"
              title={t("plusMenu.goalModeActive")}
            >
              <Target size={14} />
            </span>
          </>
        )}
        {worktreeMode && (
          <>
            <span className="toolbar-divider" aria-hidden="true" />
            <span
              className="plan-mode-badge"
              title={t("plusMenu.worktreeModeActive")}
            >
              <GitBranch size={14} />
            </span>
          </>
        )}
        {yoloMode && (
          <>
            <span className="toolbar-divider" aria-hidden="true" />
            <Tooltip content={t("plusMenu.yoloModeActive")}>
              <span
                className="plan-mode-badge yolo-mode-badge"
                aria-label={t("plusMenu.yoloModeActive")}
              >
                <ShieldAlert size={14} />
              </span>
            </Tooltip>
          </>
        )}
      </div>
      <div className="toolbar-right">
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
          isCompacting={isCompacting}
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
