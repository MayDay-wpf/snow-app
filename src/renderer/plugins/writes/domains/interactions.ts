import type { SnowRemoteControlApi } from "../../../types/remoteControl";
import { l10n } from "../helpers";
import type { PluginWriteActionDefinition } from "../types";

/**
 * 复用远控桥（window.__snowRemoteControl）的授权与提问实现：同一套
 * 「仅当前激活会话」校验与结算路径。插件不能代批敏感命令 / 敏感配置，
 * 这类操作只能由电脑端独立确认；拒绝不受此限制。
 */
const remoteBridge = (): SnowRemoteControlApi => {
  const api = window.__snowRemoteControl;
  if (!api) {
    throw new Error("Remote control bridge is not ready");
  }
  return api;
};

const readString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Parameter '${name}' must be a non-empty string`);
  }
  return value.trim();
};

const readStringArray = (value: unknown, name: string): string[] => {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`Parameter '${name}' must be a string array`);
  }
  return value;
};

export const INTERACTION_WRITE_ACTIONS: PluginWriteActionDefinition[] = [
  {
    domain: "interactions",
    action: "approveAuthorization",
    scope: "toolApproval",
    summary: l10n(
      "Approve a pending tool authorization of the active conversation",
      "批准当前激活会话中待处理的工具授权",
      "批准目前啟用工作階段中待處理的工具授權",
    ),
    invoke: async ({ params }) => {
      const authorizationId = readString(
        params.authorizationId,
        "authorizationId",
      );
      const api = remoteBridge();
      const state = await api.getState();
      const item = state.pendingAuthorizations.find(
        (entry) => entry.authorizationId === authorizationId,
      );
      if (!item) {
        throw new Error("Authorization request not found or expired");
      }
      if (item.sensitive) {
        throw new Error(
          "Sensitive operations must be confirmed on the desktop",
        );
      }
      return api.approve(authorizationId);
    },
  },
  {
    domain: "interactions",
    action: "rejectAuthorization",
    scope: "toolApproval",
    summary: l10n(
      "Reject a pending tool authorization of the active conversation",
      "拒绝当前激活会话中待处理的工具授权",
      "拒絕目前啟用工作階段中待處理的工具授權",
    ),
    invoke: async ({ params }) => {
      const authorizationId = readString(
        params.authorizationId,
        "authorizationId",
      );
      const reason =
        typeof params.reason === "string" ? params.reason : undefined;
      return remoteBridge().reject(authorizationId, reason);
    },
  },
  {
    domain: "interactions",
    action: "answerQuestion",
    scope: "conversations",
    summary: l10n(
      "Answer a pending question asked by the assistant",
      "回答助手发出的待处理提问",
      "回答助理發出的待處理提問",
    ),
    invoke: async ({ params }) =>
      remoteBridge().answer(
        readString(params.questionId, "questionId"),
        readStringArray(params.selectedOptions, "selectedOptions"),
        readStringArray(params.customAnswers, "customAnswers"),
      ),
  },
  {
    domain: "interactions",
    action: "cancelQuestion",
    scope: "conversations",
    summary: l10n(
      "Cancel a pending question asked by the assistant",
      "取消助手发出的待处理提问",
      "取消助理發出的待處理提問",
    ),
    invoke: async ({ params }) =>
      remoteBridge().cancelQuestion(
        readString(params.questionId, "questionId"),
      ),
  },
];
