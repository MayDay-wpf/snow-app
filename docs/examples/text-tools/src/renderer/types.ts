import type * as React from "react";

// Only the slot fields used by this example; no runtime import from the host.
export type ToolCallContext = Readonly<{
  slot: "tool-call";
  toolCall: Readonly<{
    name: string;
    arguments: string;
    status: "pending" | "running" | "completed" | "error";
    result?: string;
  }>;
}>;

type ToolCallNodeProps = {
  toolName: string;
  badgeName: string;
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
