import { useEffect, useMemo, useState } from "react";
import type {
  ChatConversationMessage,
  FileChangeRecord,
} from "../chatMessages/utils/conversationTypes";
import { resolveConversationChangeChain } from "../chatMessages/hooks/conversationChangeChain";

type UseConversationFileChangesParams = {
  conversationId?: string;
  checkpointIds?: string[];
  baselineCheckpointId?: string;
  workDir?: string;
  messages: ChatConversationMessage[];
  conversationVersion: number;
  fallbackChanges: FileChangeRecord[];
  worktreeMode?: boolean;
  worktreeId?: string | null;
  directoryId?: string;
};

type CheckpointSummaries = Awaited<
  ReturnType<typeof window.snow.listCheckpointSummariesBatch>
>;

type CheckpointSummaryState = {
  conversationKey: string;
  summaries: CheckpointSummaries | null;
  source: { checkpointIds: string[]; workDir: string } | null;
};

const normalizePath = (filePath: string): string =>
  filePath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .toLowerCase();

const findFallbackChange = (
  checkpointPath: string,
  fallbackChanges: FileChangeRecord[],
): FileChangeRecord | undefined => {
  const normalizedCheckpointPath = normalizePath(checkpointPath);
  return fallbackChanges.find((change) => {
    const normalizedToolPath = normalizePath(change.filePath);
    return (
      normalizedToolPath === normalizedCheckpointPath ||
      normalizedToolPath.endsWith(`/${normalizedCheckpointPath}`)
    );
  });
};

const toFileChangeKind = (changeType: string): FileChangeRecord["kind"] => {
  if (changeType === "added") {
    return "create";
  }
  if (changeType === "deleted") {
    return "delete";
  }
  return "edit";
};

/**
 * 会话文件变更 = 回滚本会话时真正会恢复的文件：检查点链取整条会话（加上
 * WorkFlow 节点 flow 检查点），includeAll=false 与 rollback 弹窗完全一致。
 * 只拉取变更摘要（类型 + 增删行数），diff 明细在查看时按页读取。
 * 工具记录的统计只用于补齐代理归属，不再追加条目，保证两个入口列表一致；
 * 只有在检查点链不可用（无检查点、读取失败，如子代理会话）时才退回统计。
 */
export const useConversationFileChanges = ({
  conversationId,
  checkpointIds,
  baselineCheckpointId,
  workDir,
  messages,
  conversationVersion,
  fallbackChanges,
  worktreeMode,
  worktreeId,
  directoryId,
}: UseConversationFileChangesParams): FileChangeRecord[] => {
  const completedToolSignature = useMemo(
    () =>
      messages
        .flatMap((message) => message.toolCalls ?? [])
        .filter(
          (toolCall) =>
            toolCall.status === "completed" || toolCall.status === "error",
        )
        .map(
          (toolCall) =>
            `${toolCall.interactionId}:${toolCall.status}:${toolCall.result?.length ?? 0}`,
        )
        .join("|"),
    [messages],
  );

  const orderedCheckpointIds = useMemo(
    () => [...new Set(checkpointIds ?? [])],
    [checkpointIds],
  );
  const messageCheckpointIds = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user" && message.checkpointId)
        .map((message) => message.checkpointId as string),
    [messages],
  );
  const canUseCheckpoint = Boolean(
    workDir &&
    (orderedCheckpointIds.length > 0 ||
      messageCheckpointIds.length > 0 ||
      baselineCheckpointId),
  );
  // 会话 + 工作区身份：同会话重算时沿用上一次结果，避免列表抖动。
  const conversationKey = `${conversationId ?? ""}|${workDir ?? ""}`;
  const checkpointRequestKey = useMemo(
    () =>
      JSON.stringify([
        conversationKey,
        orderedCheckpointIds,
        messageCheckpointIds,
        baselineCheckpointId ?? "",
        completedToolSignature,
        conversationVersion,
      ]),
    [
      baselineCheckpointId,
      completedToolSignature,
      conversationKey,
      conversationVersion,
      messageCheckpointIds,
      orderedCheckpointIds,
    ],
  );
  const [checkpointState, setCheckpointState] =
    useState<CheckpointSummaryState>({
      conversationKey: "",
      summaries: null,
      source: null,
    });

  useEffect(() => {
    if (!canUseCheckpoint || !workDir) {
      return;
    }

    let cancelled = false;
    const loadCheckpointSummaries = async (): Promise<void> => {
      try {
        const chain = await resolveConversationChangeChain({
          conversationId,
          checkpointIds: orderedCheckpointIds,
          baselineCheckpointId,
          workDir,
          messages,
          worktreeMode,
          worktreeId,
          directoryId,
        });
        if (!chain) {
          if (!cancelled) {
            setCheckpointState({
              conversationKey,
              summaries: null,
              source: null,
            });
          }
          return;
        }
        // includeAll=false：与回滚弹窗同一语义，只列出回滚真正会恢复的文件。
        const summaries = await window.snow.listCheckpointSummariesBatch(
          chain.checkpointIds,
          chain.workDir,
          false,
        );
        if (!cancelled) {
          setCheckpointState({
            conversationKey,
            summaries,
            source: {
              checkpointIds: chain.checkpointIds,
              workDir: chain.workDir,
            },
          });
        }
      } catch {
        if (!cancelled) {
          setCheckpointState({
            conversationKey,
            summaries: null,
            source: null,
          });
        }
      }
    };

    void loadCheckpointSummaries();

    return () => {
      cancelled = true;
    };
  }, [
    canUseCheckpoint,
    checkpointRequestKey,
    workDir,
    worktreeMode,
    worktreeId,
    directoryId,
    conversationId,
  ]);

  return useMemo(() => {
    const { summaries, source } = checkpointState;
    if (
      !canUseCheckpoint ||
      summaries === null ||
      source === null ||
      checkpointState.conversationKey !== conversationKey
    ) {
      return fallbackChanges;
    }

    return summaries.map((summary, index) => {
      const fallback = findFallbackChange(summary.path, fallbackChanges);
      return {
        filePath: fallback?.filePath ?? summary.path,
        fileKey: fallback?.fileKey,
        source: fallback?.source,
        root: fallback?.root,
        kind: toFileChangeKind(summary.changeType),
        agent: fallback?.agent ?? "main",
        subAgentName: fallback?.subAgentName,
        timestamp: fallback?.timestamp ?? index,
        lineStats: {
          additions: summary.additions,
          deletions: summary.deletions,
        },
        // 明细按检查点链路径读取（filePath 可能是工具记录里的展示路径）。
        checkpointSource: { ...source, path: summary.path },
      };
    });
  }, [canUseCheckpoint, checkpointState, conversationKey, fallbackChanges]);
};
