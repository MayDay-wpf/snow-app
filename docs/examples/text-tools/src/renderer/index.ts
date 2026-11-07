import type { ReactNode } from "react";
import type { ToolCallApi, ToolCallContext } from "./types";

export function renderTextInspect(
  api: ToolCallApi,
  context: ToolCallContext,
): ReactNode {
  const { React, ToolCallNode } = api.ui;
  const { toolCall } = context;
  const body =
    toolCall.result === undefined
      ? api.t(`status.${toolCall.status}`)
      : toolCall.result;

  return React.createElement(
    ToolCallNode,
    {
      toolName: toolCall.name,
      badgeName: api.t("tool.inspect"),
      category: "read",
      status: toolCall.status,
    },
    React.createElement("pre", null, body),
  );
}
