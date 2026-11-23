import type * as React from "react";

// Only the slot fields used by this example; no runtime import from the host.
export type ToolCallContext = Readonly<{
  slot: "tool-call";
  toolCall: Readonly<{
    name: string;
    arguments: string;
    status: "pending" | "running" | "completed" | "error";
    result?: string;
    /** Host timestamp (epoch ms) when the call entered running; render live elapsed from it. */
    startedAt?: number;
  }>;
}>;

type ToolCallNodeProps = {
  toolName: string;
  /** Confirmed ownership, so the host draws the plugin origin without re-resolving it. */
  sourcePluginId?: string;
  badgeName: string;
  /** Plugin-chosen badge icon; ignored by hosts that predate the prop. */
  badgeIcon?: React.ReactNode;
  category: "read";
  status: ToolCallContext["toolCall"]["status"];
  children?: React.ReactNode;
};

export type ToolCallApi = Readonly<{
  t: (key: string) => string;
  ui: Readonly<{
    React: typeof React;
    ToolCallNode: React.ComponentType<ToolCallNodeProps>;
  }>;
}>;
