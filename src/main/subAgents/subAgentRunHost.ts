import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { getMainWindow } from "../app/mainWindow";
import {
  getDetachedConversationIds,
  isDetachedPanelWebContents,
} from "../app/detachedPanelWindow";
import type { NativeBridge } from "../native/types";
import { snowLog } from "../../utils/snowLogger";
import { SUB_AGENT_CANCELLATION_SOURCES } from "../../shared/subAgentRuns";
import type {
  SubAgentRunCommand,
  SubAgentRunCommandResult,
} from "../../shared/subAgentRuns";

const mutations = new Set([
  "accept",
  "queue_message",
  "take_messages",
  "transition",
  "settle",
  "cancel",
  "receive",
  "parent_task",
  "prepare_delete",
  "prepare_rollback",
  "acknowledge_wake",
  "peer_message",
  "close_if_idle",
  "release_rollback",
  "mark_rollback_restoring",
]);
const operations = new Set([
  ...mutations,
  "lookup_request",
  "get",
  "list",
  "events",
  "deletion_status",
  "rollback_status",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const EMPTY_RUN_LIST: SubAgentRunCommandResult = {
  success: true,
  kind: "runs",
  runs: [],
  total: 0,
};
const identifier = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error("VALIDATION_ERROR: invalid sub-agent identity");
  return value;
};
const assertHost = (event: IpcMainInvokeEvent): void => {
  const window = getMainWindow();
  if (
    !(
      (window &&
        !window.isDestroyed() &&
        event.sender === window.webContents) ||
      isDetachedPanelWebContents(event.sender)
    ) ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error(
      "PERMISSION_DENIED: sub-agent runtime requires the Snow desktop main frame",
    );
};
let broadcastRunChanges: (() => void) | undefined;
/** Settings commits reuse the same host invalidation as durable run mutations. */
export const notifySubAgentCapacityChanged = (): void => {
  broadcastRunChanges?.();
};
export const registerSubAgentRunHost = (native: NativeBridge): void => {
  const owners = new Map<
    number,
    { id: string; contents: WebContents; cleanup: Promise<void> }
  >();
  const broadcast = (): void => {
    const contents = new Map(
      [...owners].map(([id, owner]) => [id, owner.contents]),
    );
    const main = getMainWindow();
    if (main && !main.isDestroyed())
      contents.set(main.webContents.id, main.webContents);
    for (const target of contents.values()) {
      if (!target.isDestroyed()) target.send("sub-agents:changed");
    }
  };
  broadcastRunChanges = broadcast;
  const ownerFor = (event: IpcMainInvokeEvent) => {
    const contents = event.sender;
    let owner = owners.get(contents.id);
    if (!owner) {
      owner = { id: randomUUID(), contents, cleanup: Promise.resolve() };
      owners.set(contents.id, owner);
      const lost = (): void => {
        const current = owners.get(contents.id);
        if (!current) return;
        const lostId = current.id;
        current.id = randomUUID();
        current.cleanup = current.cleanup.then(async () => {
          await native.subAgentRunCommand(
            JSON.stringify({ op: "recover", ownerInstanceId: lostId }),
          );
          snowLog.warn({
            module: "sub-agents",
            func: "owner_lost",
            message: "Sub-agent renderer owner lost",
            context: JSON.stringify({ ownerInstanceId: lostId }),
          });
          broadcast();
        });
        // Retain the rejecting cleanup barrier; later accepts cannot bypass failed recovery.
        void current.cleanup.catch(() =>
          snowLog.error({
            module: "sub-agents",
            func: "owner_lost",
            message: "PERSISTENCE_ERROR: sub-agent owner recovery failed",
            context: JSON.stringify({ ownerInstanceId: lostId }),
          }),
        );
      };
      contents.on("render-process-gone", lost);
      contents.on("did-navigate", lost);
      contents.once("destroyed", lost);
    }
    return owner;
  };
  ipcMain.handle(
    "sub-agents:command",
    async (event, value: unknown): Promise<SubAgentRunCommandResult> => {
      assertHost(event);
      if (
        !record(value) ||
        typeof value.op !== "string" ||
        !operations.has(value.op) ||
        !record(value.scope)
      )
        throw new Error("VALIDATION_ERROR: unsupported sub-agent command");
      if (
        value.op === "cancel" &&
        value.source !== undefined &&
        !SUB_AGENT_CANCELLATION_SOURCES.some(
          (source) => source === value.source,
        )
      )
        throw new Error("VALIDATION_ERROR: invalid cancellation source");
      const parentId = identifier(value.scope.parentConversationId);
      const projectId = identifier(value.scope.projectId);
      const parent = await native.getChatConversation(parentId);
      // 侧边栏每行都会在运行变更广播后重查 list；父会话恰好被删除（如回滚首条
      // 消息）时没有运行事实可读，按空列表回执而不是抛错。
      if (!parent && value.op === "list") return EMPTY_RUN_LIST;
      if (!parent || parent.directoryId !== projectId) {
        snowLog.warn({
          module: "sub-agents",
          func: value.op,
          message: "Sub-agent command scope rejected",
          context: JSON.stringify({
            parentConversationId: /^[A-Za-z0-9:_-]{1,160}$/.test(parentId)
              ? parentId
              : undefined,
            parentExists: Boolean(parent),
            projectMatches: parent?.directoryId === projectId,
          }),
        });
        throw new Error("PERMISSION_DENIED: sub-agent parent/project mismatch");
      }
      const owner = ownerFor(event);
      await owner.cleanup;
      assertHost(event);
      const command = {
        ...value,
        scope: {
          projectId: parent.directoryId,
          parentConversationId: parent.conversationId,
        },
        ownerInstanceId: owner.id,
      } as SubAgentRunCommand;
      // 普通主会话可派发同步/异步子代理；Workflow 节点只允许同步派发。
      const isWorkflowNode = parent.conversationType === "workflow_node";
      if (
        (command.op === "accept" || command.op === "queue_message") &&
        !isWorkflowNode &&
        (parent.conversationType !== "main" || parent.parentConversationId)
      )
        throw new Error(
          "UNSUPPORTED_EXECUTION_MODE: sub-agent dispatch requires an ordinary parent conversation or a workflow node",
        );
      if (
        command.op === "accept" &&
        isWorkflowNode &&
        command.executionMode !== "sync"
      )
        throw new Error(
          "UNSUPPORTED_EXECUTION_MODE: workflow nodes support synchronous sub-agents only",
        );
      if (command.op === "accept") {
        if (!record(command.snapshot))
          throw new Error("VALIDATION_ERROR: missing execution snapshot");
        const group = command.snapshot.collaborationGroup;
        if (
          group !== undefined &&
          (typeof group !== "string" ||
            !group.trim() ||
            Array.from(group).length > 80)
        )
          throw new Error("VALIDATION_ERROR: invalid collaboration group");
        const modes = await native.getConversationModes(parentId);
        const binding = await native.getConversationWorktree(parentId);
        const directories = await native.listWorkspaceDirectories();
        const directory = directories.find(
          (item) => item.directoryId === parent.directoryId,
        );
        const useWorktree = Boolean(modes.worktreeMode);
        if (
          useWorktree &&
          (!binding?.isValid || binding.directoryId !== parent.directoryId)
        )
          throw new Error(
            "CONFIGURATION_ERROR: fixed worktree binding is unavailable",
          );
        const workspacePath =
          binding?.isValid &&
          binding.directoryId === parent.directoryId &&
          binding.worktreePath.trim()
            ? binding.worktreePath
            : directory?.path;
        if (
          !workspacePath ||
          command.snapshot.workspacePath !== workspacePath ||
          command.snapshot.worktreeMode !== useWorktree
        )
          throw new Error(
            "PERMISSION_DENIED: execution workspace does not match host binding",
          );
        command.snapshot = {
          ...command.snapshot,
          workspacePath,
          worktreeMode: useWorktree,
        };
      }
      // Reuse existing detached conversation ownership; queries and old-owner
      // settlement/cancellation remain available, but main cannot create a new
      // execution or consume parent input while that conversation is detached.
      if (
        !isDetachedPanelWebContents(event.sender) &&
        getDetachedConversationIds().includes(parentId) &&
        (command.op === "accept" ||
          command.op === "queue_message" ||
          command.op === "receive" ||
          command.op === "acknowledge_wake" ||
          command.op === "close_if_idle" ||
          command.op === "prepare_rollback" ||
          command.op === "mark_rollback_restoring" ||
          command.op === "release_rollback" ||
          (command.op === "parent_task" && command.state === "open"))
      ) {
        throw new Error(
          "OWNER_MISMATCH: continue this conversation in its detached window",
        );
      }
      const commandStartedAt = Date.now();
      let raw: unknown;
      try {
        raw = JSON.parse(
          await native.subAgentRunCommand(JSON.stringify(command)),
        );
        if (
          !record(raw) ||
          raw.success !== true ||
          typeof raw.kind !== "string"
        )
          throw new Error("PERSISTENCE_ERROR: malformed native run receipt");
      } catch (error) {
        // Keep the original rejection. Only fixed classifications and bounded
        // identities go to diagnostics, never command text or raw exceptions.
        let message = error instanceof Error ? error.message : "";
        // The parent can be archived or deleted between the host identity check
        // and the durable command's own scope check. Renderers already treat a
        // missing parent as an empty run list, so surface that classification
        // instead of a permission error; genuine project mismatches still throw.
        if (
          message.startsWith(
            "PERMISSION_DENIED: parent/project scope does not exist or does not match",
          )
        ) {
          let parentMissing = false;
          try {
            parentMissing = !(await native.getChatConversation(parentId));
          } catch {
            // A failed re-check keeps the original permission classification.
          }
          if (parentMissing) {
            // 只读 list 与删除并发：父会话已不存在即没有运行，返回空列表。
            if (command.op === "list") return EMPTY_RUN_LIST;
            message = "RUN_NOT_FOUND: parent conversation does not exist";
            error = new Error(message);
          }
        }
        const code =
          /^(RUN_BUSY|RUN_NOT_FOUND|OWNER_MISMATCH|PERMISSION_DENIED|INVALID_TRANSITION|PERSISTENCE_ERROR|VALIDATION_ERROR|CONVERSATION_DELETING|DELETE_PENDING):/.exec(
            message,
          )?.[1] ?? "COMMAND_FAILED";
        const diagnosticId = (input: unknown): string | undefined =>
          typeof input === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(input)
            ? input
            : undefined;
        try {
          snowLog.warn({
            module: "sub-agents",
            func: command.op,
            message: "Sub-agent durable command rejected",
            context: JSON.stringify({
              code,
              parentConversationId: diagnosticId(parentId),
              conversationId: diagnosticId(value.conversationId),
              runId: diagnosticId(value.runId),
              ownerInstanceId: owner.id,
              requiresExplicitContinue:
                command.op === "queue_message" && code === "RUN_BUSY",
            }),
            duration: `${Math.max(0, Date.now() - commandStartedAt)}ms`,
          });
        } catch {
          // Reporting must never replace the original command failure.
        }
        throw error;
      }
      // Capacity checks and lost CAS transitions are read-only receipts. Do not
      // invalidate their own subscription: that would turn host waiting into an
      // unbounded transition -> broadcast -> retry loop across windows.
      if (
        mutations.has(command.op) &&
        !(raw.kind === "transition" && raw.changed === false)
      ) {
        const cancellation = raw.cancellation;
        broadcast();
        snowLog.info({
          module: "sub-agents",
          func: command.op,
          message: "Sub-agent durable command committed",
          context: JSON.stringify({
            parentConversationId: parentId,
            runId: "runId" in command ? command.runId : undefined,
            kind: raw.kind,
            ...(command.op === "cancel" && raw.kind === "cancel"
              ? {
                  disposition: [
                    "requested",
                    "confirmed",
                    "already_terminal",
                    "too_late",
                  ].includes(String(raw.disposition))
                    ? raw.disposition
                    : undefined,
                  runStatus: [
                    "queued",
                    "running",
                    "waiting_input",
                    "finalizing",
                    "cancelling",
                    "completed",
                    "failed",
                    "cancelled",
                    "interrupted",
                  ].includes(String(raw.runStatus))
                    ? raw.runStatus
                    : undefined,
                  cancellation:
                    record(cancellation) &&
                    SUB_AGENT_CANCELLATION_SOURCES.some(
                      (source) => source === cancellation.source,
                    ) &&
                    typeof cancellation.requestedAt === "number" &&
                    Number.isSafeInteger(cancellation.requestedAt) &&
                    cancellation.requestedAt >= 0
                      ? {
                          source: cancellation.source,
                          requestedAt: cancellation.requestedAt,
                        }
                      : undefined,
                }
              : {}),
          }),
        });
      }
      return raw as SubAgentRunCommandResult;
    },
  );
};
