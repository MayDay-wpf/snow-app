import { memo, useMemo } from "react";
import type {
  ConversationContextValue,
  HookExecutionRecord,
  ToolCallInfo,
} from "../utils/conversationTypes";
import { parseToolAction } from "../utils/toolActionPolicy";
import {
  AskUserQuestionToolCall,
  BashToolCall,
  FilesystemReadToolCall,
  FilesystemEditToolCall,
  FilesystemCreateToolCall,
  FilesystemCopyToolCall,
  TodoToolCall,
  GrepToolCall,
  FindToolCall,
  ToolSearchToolCall,
  SubAgentToolCall,
  SubAgentMessageToolCall,
  CodebaseToolCall,
  LspToolCall,
  WebSearchToolCall,
  ImageGenToolCall,
  ImageDescribeToolCall,
  BrowserToolCall,
  BrowserShareRequestCard,
  TerminalToolCall,
  ComputerUseToolCall,
  HtmlRenderToolCall,
  DecisionToolCall,
  SkillToolCall,
  ConfigToolCall,
  AppLogsToolCall,
  AppControlToolCall,
  MemoryToolCall,
  WorkflowToolCall,
  GenericToolCall,
  ToolCorrectionTree,
} from "../toolCalls";
import { PluginToolCall } from "./PluginToolCall";
import { SubAgentRunToolCall } from "../toolCalls/SubAgentRunToolCall";
import { ToolRejectionNotice } from "../toolCalls/shared/ToolRejectionNotice";
import { parseToolRejection } from "../toolCalls/shared/toolRejection";

type ToolCallItemProps = {
  toolCall: ToolCallInfo;
  /** Conversation this tool call belongs to (used by workflow renderer). */
  conversationId?: string;
  /** 该工具调用所在助手消息的 id（bash 卡片本地收口时定位消息）。 */
  messageId?: string;
  /** 会话消息更新函数：透传给需要本地收口的工具卡片（见 BashToolCall）。 */
  updateSessionMessages?: ConversationContextValue["updateSessionMessages"];
  /** Hook execution records bound to this tool call (matched by
   *  toolCallInteractionId).  Forwarded to the sub-agent card renderer;
   *  other tool renderers ignore it. */
  hookExecutions?: HookExecutionRecord[];
};

const renderToolCall = ({
  toolCall,
  conversationId,
  messageId,
  updateSessionMessages,
  hookExecutions,
}: ToolCallItemProps): React.JSX.Element => {
  // Delegate to specialized renderers based on tool name
  if (toolCall.name === "user-interaction-askUserQuestion") {
    return <AskUserQuestionToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "workflow-workflow-generate") {
    return (
      <WorkflowToolCall toolCall={toolCall} conversationId={conversationId} />
    );
  }

  // 失败节点续跑卡片：与 generate 卡片同一组件（复用画布渲染与事件
  // 订阅），mode=resume 下只读展示续跑节点状态；两卡片按事件来源做
  // 画布宿主切换（续跑进行中上方 generate 卡片画布收起）。
  if (toolCall.name === "workflow-workflow-resume") {
    return (
      <WorkflowToolCall
        toolCall={toolCall}
        conversationId={conversationId}
        mode="resume"
      />
    );
  }

  if (toolCall.name === "filesystem-read") {
    return <FilesystemReadToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "filesystem-replace_edit") {
    return <FilesystemEditToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "filesystem-create") {
    return <FilesystemCreateToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "filesystem-copy") {
    return <FilesystemCopyToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "bash-terminal-execute") {
    return (
      <BashToolCall
        toolCall={toolCall}
        conversationId={conversationId}
        messageId={messageId}
        updateSessionMessages={updateSessionMessages}
      />
    );
  }

  if (toolCall.name === "todo-todo-manage") {
    return <TodoToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "grep-search") {
    return <GrepToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "grep-find") {
    return <FindToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "toolSearch-discover") {
    return <ToolSearchToolCall toolCall={toolCall} />;
  }

  if (
    toolCall.name === "sub-agents-activate" ||
    toolCall.name === "sub-agents-continue"
  ) {
    return (
      <SubAgentToolCall
        toolCall={toolCall}
        parentConversationId={conversationId}
        hookExecutions={hookExecutions}
        mode={toolCall.name === "sub-agents-continue" ? "continue" : "activate"}
      />
    );
  }

  if (
    toolCall.name === "sub-agents-getResult" ||
    toolCall.name === "sub-agents-cancel"
  ) {
    return (
      <SubAgentRunToolCall
        toolCall={toolCall}
        conversationId={conversationId}
      />
    );
  }

  if (toolCall.name === "sub-agents-sendMessage") {
    return (
      <SubAgentMessageToolCall
        toolCall={toolCall}
        conversationId={conversationId}
      />
    );
  }

  if (toolCall.name === "codebase-search") {
    return <CodebaseToolCall toolCall={toolCall} />;
  }

  if (toolCall.name.startsWith("lsp-")) {
    return <LspToolCall toolCall={toolCall} />;
  }

  if (
    toolCall.name === "websearch-websearch-search" ||
    toolCall.name === "websearch-websearch-fetch"
  ) {
    return <WebSearchToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "imagegen-generate") {
    return <ImageGenToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "imagegen-image-describe") {
    return <ImageDescribeToolCall toolCall={toolCall} />;
  }

  // 共享申请期间由会话区卡片承载允许 / 拒绝交互（申请结算后交回常规卡片）。
  if (toolCall.name === "browser-request_share") {
    return <BrowserShareRequestCard toolCall={toolCall} />;
  }

  if (toolCall.name.startsWith("browser-")) {
    return <BrowserToolCall toolCall={toolCall} />;
  }

  if (toolCall.name.startsWith("terminal-")) {
    return <TerminalToolCall toolCall={toolCall} />;
  }

  if (toolCall.name.startsWith("computer-use-")) {
    return <ComputerUseToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "html-render") {
    return <HtmlRenderToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "decision-evaluate") {
    return <DecisionToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "skills-skill-execute") {
    return <SkillToolCall toolCall={toolCall} />;
  }

  if (toolCall.name === "config-manage") {
    return parseToolAction(toolCall.arguments) === "logs" ? (
      <AppLogsToolCall toolCall={toolCall} />
    ) : (
      <ConfigToolCall toolCall={toolCall} />
    );
  }

  if (toolCall.name.startsWith("config-")) {
    return <ConfigToolCall toolCall={toolCall} />;
  }

  if (toolCall.name.startsWith("app-control-")) {
    return <AppControlToolCall toolCall={toolCall} />;
  }

  if (toolCall.name.startsWith("memory-")) {
    return <MemoryToolCall toolCall={toolCall} />;
  }

  // Plugins only occupy the generic slot, after every built-in safety UI.
  return (
    <PluginToolCall
      toolCall={toolCall}
      conversationId={conversationId}
      messageId={messageId}
      fallback={<GenericToolCall toolCall={toolCall} />}
    />
  );
};

export const ToolCallItem = memo(
  ({
    toolCall,
    conversationId,
    messageId,
    updateSessionMessages,
    hookExecutions,
  }: ToolCallItemProps): React.JSX.Element => {
    // The correction state is the source of truth for the visible status:
    // a parallel tool wrapper may settle and mark the call completed after
    // correction has already started, which would otherwise hide the spinner.
    const correctionRunning = toolCall.correction?.status === "running";
    const displayToolCall = useMemo<ToolCallInfo>(
      () =>
        correctionRunning
          ? {
              ...toolCall,
              status: "running",
              result: undefined,
              streamingStdout: undefined,
              streamingStderr: undefined,
            }
          : toolCall,
      [correctionRunning, toolCall],
    );

    const rejection = useMemo(
      () => parseToolRejection(displayToolCall.result),
      [displayToolCall.result],
    );

    const content = renderToolCall({
      toolCall: displayToolCall,
      conversationId,
      messageId,
      updateSessionMessages,
      hookExecutions,
    });

    if (!rejection && !toolCall.correction) {
      return content;
    }

    // 拒绝理由常驻展示：提示条是 .tcg-list 的直接子项，不放进卡片 details
    // 内部——details 收起时浏览器会隐藏其非 summary 内容，理由就看不见了。
    return (
      <>
        {content}
        {toolCall.correction ? (
          <ToolCorrectionTree correction={toolCall.correction} />
        ) : null}
        {rejection ? <ToolRejectionNotice rejection={rejection} /> : null}
      </>
    );
  },
);

ToolCallItem.displayName = "ToolCallItem";
