import { useEffect, useRef } from "react";

import type { ChatConversationRecord } from "../../../../../preload";
import { parseDbTimestamp } from "../../../sidebar/mainSidebar/chatTimeGroup";
import type {
  ConversationSessionState,
  TokenUsage,
  UseChatConversationResult,
} from "../utils/conversationTypes";
import { isPendingSessionKey } from "../utils/conversationTypes";

type UseProjectSwitchAutoSelectParams = {
  directoryId: string;
  activeConversationId: string | undefined;
  newChatRequested: boolean;
  sessions: Record<string, ConversationSessionState>;
  streamingConversationIds: Set<string>;
  attentionRequiredConversationIds: Set<string>;
  handleSelectConversation: UseChatConversationResult["handleSelectConversation"];
  handleNewChat: UseChatConversationResult["handleNewChat"];
  /**
   * false = 不参与自动选中（会话面板：绑定的会话不随主视图项目切换）。
   * 缺省 true，即主聊天视图的原有行为。
   */
  enabled?: boolean;
};

type RunningConversationCandidate = {
  conversationId: string;
  updatedAtMs: number;
  record: ChatConversationRecord | null;
};

const toTokenUsage = (record: ChatConversationRecord): TokenUsage => ({
  inputTokens: record.inputTokens,
  outputTokens: record.outputTokens,
  cacheCreationInputTokens: record.cacheCreationInputTokens,
  cacheReadInputTokens: record.cacheReadInputTokens,
});

export const useProjectSwitchAutoSelect = ({
  directoryId,
  activeConversationId,
  newChatRequested,
  sessions,
  streamingConversationIds,
  attentionRequiredConversationIds,
  handleSelectConversation,
  handleNewChat,
  enabled = true,
}: UseProjectSwitchAutoSelectParams): void => {
  const requestIdRef = useRef(0);
  const sessionsRef = useRef(sessions);
  const activeConversationIdRef = useRef(activeConversationId);
  const newChatRequestedRef = useRef(newChatRequested);
  const streamingIdsRef = useRef(streamingConversationIds);
  const attentionIdsRef = useRef(attentionRequiredConversationIds);
  const handleSelectConversationRef = useRef(handleSelectConversation);
  const handleNewChatRef = useRef(handleNewChat);
  sessionsRef.current = sessions;
  activeConversationIdRef.current = activeConversationId;
  newChatRequestedRef.current = newChatRequested;
  streamingIdsRef.current = streamingConversationIds;
  attentionIdsRef.current = attentionRequiredConversationIds;
  handleSelectConversationRef.current = handleSelectConversation;
  handleNewChatRef.current = handleNewChat;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const targetDirectoryId = directoryId;
    if (!targetDirectoryId) {
      return;
    }
    const requestId = ++requestIdRef.current;
    const isCurrentRequest = (): boolean => requestId === requestIdRef.current;

    const resolveConversationDirectoryId = async (
      conversationId: string,
    ): Promise<string | undefined> => {
      const cached = sessionsRef.current[conversationId]?.directoryId;
      if (cached) {
        return cached;
      }
      if (isPendingSessionKey(conversationId)) {
        return "";
      }
      try {
        const record = await window.snow.getChatConversation(conversationId);
        return record?.directoryId ?? "";
      } catch {
        return undefined;
      }
    };

    const shouldKeepDisplayedConversation = async (): Promise<boolean> => {
      if (newChatRequestedRef.current) {
        return true;
      }
      const displayedId = activeConversationIdRef.current;
      if (!displayedId) {
        return false;
      }
      const displayedDirectoryId =
        await resolveConversationDirectoryId(displayedId);
      if (displayedDirectoryId === undefined) {
        return true;
      }
      return displayedDirectoryId === targetDirectoryId;
    };

    const resolveRunningCandidates = async (): Promise<
      RunningConversationCandidate[]
    > => {
      const pendingCandidates: RunningConversationCandidate[] = [];
      const persistedIds: string[] = [];
      const runningIds = new Set([
        ...streamingIdsRef.current,
        ...attentionIdsRef.current,
      ]);

      for (const conversationId of runningIds) {
        if (isPendingSessionKey(conversationId)) {
          if (
            sessionsRef.current[conversationId]?.directoryId ===
            targetDirectoryId
          ) {
            pendingCandidates.push({
              conversationId,
              updatedAtMs: Date.now(),
              record: null,
            });
          }
          continue;
        }
        persistedIds.push(conversationId);
      }

      let records: ChatConversationRecord[] = [];
      if (persistedIds.length > 0) {
        try {
          records = await window.snow.listChatConversationsByIds(persistedIds);
        } catch {
          records = [];
        }
      }

      return [
        ...pendingCandidates,
        ...records
          .filter(
            (record) =>
              record.directoryId === targetDirectoryId &&
              record.conversationType === "main",
          )
          .map((record) => ({
            conversationId: record.conversationId,
            updatedAtMs: parseDbTimestamp(record.updatedAt).getTime(),
            record,
          })),
      ].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    };

    const run = async (): Promise<void> => {
      if (await shouldKeepDisplayedConversation()) {
        return;
      }
      if (!isCurrentRequest()) {
        return;
      }

      const candidates = await resolveRunningCandidates();
      if (!isCurrentRequest()) {
        return;
      }
      if (await shouldKeepDisplayedConversation()) {
        return;
      }
      if (!isCurrentRequest()) {
        return;
      }
      if (newChatRequestedRef.current) {
        return;
      }

      const target = candidates[0];
      if (!target) {
        handleNewChatRef.current();
        return;
      }

      const record = target.record;
      await handleSelectConversationRef.current(
        target.conversationId,
        record ? record.summary || record.title : "",
        record ? toTokenUsage(record) : undefined,
        targetDirectoryId,
      );
    };

    void run();
  }, [directoryId]);
};
