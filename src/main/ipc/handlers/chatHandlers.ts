import { ipcMain } from "electron";
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
    .map((item) => {
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
      const content =
        typeof message.content === "string" ? message.content : "";
      const toolResultsJson =
        typeof message.toolResultsJson === "string"
          ? message.toolResultsJson
          : undefined;

      return {
        role,
        content,
        ...(toolResultsJson ? { toolResultsJson } : {}),
      } as ResponsesApiMessage;
    })
    .filter((message): message is ResponsesApiMessage =>
      Boolean(message && message.content.trim())
    );

  if (messages.length === 0) {
    throw new Error(
      "Responses API request requires at least one non-empty message"
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
    checkpointId:
      typeof source.checkpointId === "string" ? source.checkpointId : undefined,
    contextCompaction:
      typeof source.contextCompaction === "boolean"
        ? source.contextCompaction
        : undefined,
    resumeAfterCompaction:
      typeof source.resumeAfterCompaction === "boolean"
        ? source.resumeAfterCompaction
        : undefined,
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
    planMode:
      typeof source.planMode === "boolean" ? source.planMode : undefined,
    goalMode:
      typeof source.goalMode === "boolean" ? source.goalMode : undefined,
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
  native: NativeBridge
): Promise<RemoteRoleContext | null> => {
  if (!directoryId) {
    return null;
  }
  try {
    const directories = await native.listWorkspaceDirectories();
    const matched = directories.find(
      (directory) => directory.directoryId === directoryId
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
  ipcMain.handle(
    "chat:create-response-stream",
    async (event, request: unknown, streamId: unknown) => {
      const normalizedRequest = normalizeResponsesApiRequest(request);
      const normalizedStreamId = normalizeCreateResponseStreamId(streamId);

      try {
        const remoteRoleContext = await resolveRemoteRoleContext(
          normalizedRequest.directoryId,
          native
        );
        return await native.createResponseStream(
          {
            ...normalizedRequest,
            ...(remoteRoleContext?.content
              ? { remoteRoleContent: remoteRoleContext.content }
              : {}),
            ...(remoteRoleContext
              ? {
                  remoteIncludeGlobalRules:
                    remoteRoleContext.includeGlobalRules,
                }
              : {}),
          },
          (chunk: ResponsesApiStreamChunk) => {
            safeSend(event.sender, CHAT_CREATE_RESPONSE_CHUNK_CHANNEL, {
              streamId: normalizedStreamId,
              chunk,
            });
          },
          normalizedStreamId
        );
      } catch (error) {
        snowLog.error({
          module: "ipc/chat",
          func: "create-response-stream",
          message: "Response stream failed",
          context: `model=${normalizedRequest.model ?? "default"}`,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
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
