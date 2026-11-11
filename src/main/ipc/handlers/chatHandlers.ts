import { ipcMain, type WebContents } from "electron";
import type {
  NativeBridge,
  ResponsesApiMessage,
  ResponsesApiRequest,
  ResponsesApiStreamChunk,
} from "../../native/types";
import {
  readRemoteRoleContext,
  type RemoteRoleContext,
} from "../../ssh/remoteWorkspaceCommand";
import { snowLog } from "../../../utils/snowLogger";
import { safeSend } from "../../utils/safeSend";
import { getMainWindow } from "../../app/mainWindow";
import { getDetachedConversationIds } from "../../app/detachedPanelWindow";

const CHAT_CREATE_RESPONSE_CHUNK_CHANNEL = "chat:create-response:chunk";

const normalizeCreateResponseStreamId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Create response stream ID is required");
  }

  return value.trim();
};

const normalizeResponsesApiRequest = (value: unknown): ResponsesApiRequest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Responses API request payload must be an object");
  }

  const source = value as Partial<Record<keyof ResponsesApiRequest, unknown>>;
  const rawMessages = Array.isArray(source.messages) ? source.messages : [];
  const messages = rawMessages
    .map((item): ResponsesApiMessage | null => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return null;
      }

      const message = item as Partial<
        Record<keyof ResponsesApiRequest["messages"][number], unknown>
      >;
      const role =
        message.role === "assistant" ||
        message.role === "system" ||
        message.role === "developer" ||
        message.role === "tool"
          ? message.role
          : "user";
      if (
        message.origin !== undefined &&
        message.origin !== "user" &&
        message.origin !== "internal" &&
        message.origin !== "unknown"
      ) {
        throw new Error("Invalid chat message origin");
      }
      const origin = message.origin;
      const content =
        typeof message.content === "string" ? message.content : "";
      const toolResultsJson =
        typeof message.toolResultsJson === "string"
          ? message.toolResultsJson
          : undefined;
      const toolCallsJson =
        typeof message.toolCallsJson === "string"
          ? message.toolCallsJson
          : undefined;

      return {
        role,
        origin,
        content,
        ...(toolResultsJson ? { toolResultsJson } : {}),
        ...(toolCallsJson ? { toolCallsJson } : {}),
      };
    })
    .filter((message): message is ResponsesApiMessage =>
      Boolean(
        message &&
        (message.content.trim() ||
          message.toolResultsJson ||
          message.toolCallsJson),
      ),
    );

  // 重试失败回合允许空消息：该回合的上下文（含已落库的工具结果）全部来自会话历史，
  // 这里只重发未落库的补充消息（通常为空）。
  const retryFailedResponse =
    typeof source.retryFailedResponse === "boolean"
      ? source.retryFailedResponse
      : undefined;
  if (messages.length === 0 && !retryFailedResponse) {
    throw new Error(
      "Responses API request requires at least one non-empty message",
    );
  }

  return {
    messages,
    model: typeof source.model === "string" ? source.model : undefined,
    apiProfile:
      typeof source.apiProfile === "string" ? source.apiProfile : undefined,
    conversationId:
      typeof source.conversationId === "string"
        ? source.conversationId
        : undefined,
    previousResponseId:
      typeof source.previousResponseId === "string"
        ? source.previousResponseId
        : undefined,
    directoryId:
      typeof source.directoryId === "string" ? source.directoryId : undefined,
    analysisWorkspaceRoot:
      typeof source.analysisWorkspaceRoot === "string"
        ? source.analysisWorkspaceRoot
        : undefined,
    checkpointId:
      typeof source.checkpointId === "string" ? source.checkpointId : undefined,
    contextCompaction:
      typeof source.contextCompaction === "boolean"
        ? source.contextCompaction
        : undefined,
    contextFold:
      typeof source.contextFold === "boolean" ? source.contextFold : undefined,
    resumeAfterCompaction:
      typeof source.resumeAfterCompaction === "boolean"
        ? source.resumeAfterCompaction
        : undefined,
    retryFailedResponse,
    subAgentToolsJson:
      typeof source.subAgentToolsJson === "string"
        ? source.subAgentToolsJson
        : undefined,
    subAgentSystemPrompt:
      typeof source.subAgentSystemPrompt === "string"
        ? source.subAgentSystemPrompt
        : undefined,
    subAgentConfigProfile:
      typeof source.subAgentConfigProfile === "string"
        ? source.subAgentConfigProfile
        : undefined,
    skipContext:
      typeof source.skipContext === "boolean" ? source.skipContext : undefined,
    internalRecoveryPrompt:
      typeof source.internalRecoveryPrompt === "string" &&
      source.internalRecoveryPrompt.trim()
        ? source.internalRecoveryPrompt
        : undefined,
    goalMode:
      typeof source.goalMode === "boolean" ? source.goalMode : undefined,
    worktreeMode:
      typeof source.worktreeMode === "boolean"
        ? source.worktreeMode
        : undefined,
    workflowMode:
      typeof source.workflowMode === "boolean"
        ? source.workflowMode
        : undefined,
    executionWorkspaceRoot:
      typeof source.executionWorkspaceRoot === "string" &&
      source.executionWorkspaceRoot.trim()
        ? source.executionWorkspaceRoot.trim()
        : undefined,
    worktreeId:
      typeof source.worktreeId === "string" && source.worktreeId.trim()
        ? source.worktreeId.trim()
        : undefined,
    thinkingStrength:
      typeof source.thinkingStrength === "string" &&
      source.thinkingStrength.trim()
        ? source.thinkingStrength
        : undefined,
    // napi-rs reads #[napi(object)] Option fields via Object::get, which
    // only treats `undefined` as absent; an explicit `null` reaches
    // `String::from_napi_value` and throws. Chat requests
    // (requestMethod != "responses") carry `responsesFastMode: null`, so
    // collapse null to undefined — Rust maps both to None ("follow the
    // profile default").
    responsesFastMode:
      typeof source.responsesFastMode === "string"
        ? source.responsesFastMode
        : undefined,
    allowedToolsJson:
      typeof source.allowedToolsJson === "string" &&
      source.allowedToolsJson.trim()
        ? source.allowedToolsJson
        : undefined,
    pluginToolIdsJson:
      typeof source.pluginToolIdsJson === "string" &&
      source.pluginToolIdsJson.trim()
        ? source.pluginToolIdsJson
        : undefined,
  };
};

/**
 * Resolve the project ROLE.md content for an SSH workspace so the Rust prompt
 * builder can inject the project role even when the working directory is a
 * remote `ssh://` path. Local workspaces are handled entirely inside Rust
 * (it reads `<workspace>/ROLE.md` and `.snow/settings.json` directly).
 *
 * Any failure (no directory, SSH unavailable, missing file) silently falls
 * back to `null` — the global ROLE.md remains the fallback.
 */
const resolveRemoteRoleContext = async (
  directoryId: string | undefined,
  native: NativeBridge,
): Promise<RemoteRoleContext | null> => {
  if (!directoryId) {
    return null;
  }
  try {
    const directories = await native.listWorkspaceDirectories();
    const matched = directories.find(
      (directory) => directory.directoryId === directoryId,
    );
    if (!matched || !matched.path.startsWith("ssh://")) {
      return null;
    }
    return readRemoteRoleContext(matched.path);
  } catch {
    return null;
  }
};

export const registerChatHandlers = (native: NativeBridge): void => {
  type Owner = {
    sender: WebContents;
    requests: Set<RequestLease>;
    detach: () => void;
  };
  type RequestLease = {
    id: string;
    owner: Owner;
    orphaned: boolean;
    settled: boolean;
  };
  const owners = new Map<WebContents, Owner>();
  const requests = new Map<string, RequestLease>();

  const forget = (lease: RequestLease): void => {
    if (requests.get(lease.id) === lease) requests.delete(lease.id);
    lease.owner.requests.delete(lease);
    if (
      lease.owner.requests.size === 0 &&
      owners.get(lease.owner.sender) === lease.owner
    ) {
      lease.owner.detach();
      owners.delete(lease.owner.sender);
    }
  };

  const track = (sender: WebContents, id: string): RequestLease => {
    if (sender.isDestroyed())
      throw new Error("Model request owner is unavailable");
    if (requests.has(id)) throw new Error("Duplicate model request identity");
    let owner = owners.get(sender);
    if (!owner) {
      const current: Owner = { sender, requests: new Set(), detach: () => {} };
      const invalidate = (): void => {
        current.detach();
        if (owners.get(sender) === current) owners.delete(sender);
        for (const lease of current.requests) {
          lease.orphaned = true;
          void Promise.resolve()
            .then(() => native.abortResponseStream(lease.id))
            .catch((error: unknown) => {
              snowLog.error({
                module: "ipc/chat",
                func: "abort-orphaned-stream",
                message: "Failed to abort orphaned stream",
                error: String(error),
              });
            });
          void native.releaseModelRequest(lease.id).catch((error: unknown) => {
            snowLog.error({
              module: "ipc/chat",
              func: "release-orphaned-request",
              message: "Failed to release orphaned model request",
              error: String(error),
            });
          });
          if (lease.settled) forget(lease);
        }
      };
      const onNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame && !isInPlace) invalidate();
      };
      current.detach = () => {
        sender.removeListener("destroyed", invalidate);
        sender.removeListener("render-process-gone", invalidate);
        sender.removeListener("did-start-navigation", onNavigation);
      };
      sender.on("destroyed", invalidate);
      sender.on("render-process-gone", invalidate);
      sender.on("did-start-navigation", onNavigation);
      owners.set(sender, current);
      owner = current;
    }
    const lease: RequestLease = { id, owner, orphaned: false, settled: false };
    owner.requests.add(lease);
    requests.set(id, lease);
    return lease;
  };

  ipcMain.handle(
    "mcp:release-model-request",
    async (event, streamId: unknown) => {
      const id = normalizeCreateResponseStreamId(streamId);
      const lease = requests.get(id);
      if (lease && lease.owner.sender !== event.sender) {
        throw new Error(
          "OWNER_MISMATCH: model request belongs to another window",
        );
      }
      await native.releaseModelRequest(id);
      if (lease) forget(lease);
    },
  );

  ipcMain.handle(
    "chat:create-response-stream",
    async (event, request: unknown, streamId: unknown) => {
      const normalizedRequest = normalizeResponsesApiRequest(request);
      const normalizedStreamId = normalizeCreateResponseStreamId(streamId);
      const lease = track(event.sender, normalizedStreamId);

      try {
        const remoteRoleContext = await resolveRemoteRoleContext(
          normalizedRequest.directoryId,
          native,
        );
        if (
          event.sender === getMainWindow()?.webContents &&
          normalizedRequest.conversationId
        ) {
          const conversation = await native.getChatConversation(
            normalizedRequest.conversationId,
          );
          // Child runs retain their captured execution owner. Only parent sends
          // are subject to existing detached conversation ownership. Recheck after
          // every await, immediately before the actual native request dispatch.
          if (
            !conversation?.parentConversationId &&
            getDetachedConversationIds().includes(
              normalizedRequest.conversationId,
            )
          ) {
            throw new Error(
              "OWNER_MISMATCH: parent model requests belong to the detached window",
            );
          }
        }
        if (lease.orphaned)
          throw new Error("Model request owner is unavailable");
        const result = await native.createResponseStream(
          {
            ...normalizedRequest,
            ...(remoteRoleContext?.content
              ? { remoteRoleContent: remoteRoleContext.content }
              : {}),
            ...(remoteRoleContext
              ? {
                  remoteIncludeGlobalRules:
                    remoteRoleContext.includeGlobalRules,
                  remoteOverrideBuiltinPrompt:
                    remoteRoleContext.overrideBuiltinPrompt,
                }
              : {}),
          },
          (chunk: ResponsesApiStreamChunk) => {
            safeSend(event.sender, CHAT_CREATE_RESPONSE_CHUNK_CHANNEL, {
              streamId: normalizedStreamId,
              chunk,
            });
          },
          normalizedStreamId,
        );
        lease.settled = true;
        const calls = result.toolCallsJson.trim();
        if (
          lease.orphaned ||
          normalizedRequest.contextCompaction ||
          !calls ||
          calls === "[]" ||
          calls === "null"
        ) {
          await native.releaseModelRequest(normalizedStreamId);
          forget(lease);
        }
        return result;
      } catch (error) {
        lease.settled = true;
        try {
          await native.releaseModelRequest(normalizedStreamId);
        } catch (releaseError) {
          snowLog.error({
            module: "ipc/chat",
            func: "release-failed-request",
            message: "Failed to release model request",
            error: String(releaseError),
          });
        }
        forget(lease);
        snowLog.error({
          module: "ipc/chat",
          func: "create-response-stream",
          message: "Response stream failed",
          context: `model=${normalizedRequest.model ?? "default"}`,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  ipcMain.handle("chat:abort-response-stream", (_event, streamId: unknown) => {
    const normalizedStreamId = normalizeCreateResponseStreamId(streamId);
    snowLog.warn({
      module: "ipc/chat",
      func: "abort-response-stream",
      message: "Response stream aborted",
      context: `streamId=${normalizedStreamId}`,
    });
    return native.abortResponseStream(normalizedStreamId);
  });
};
