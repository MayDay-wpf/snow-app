/**
 * 合并后的浏览器工具 -> action -> 原 operation 名。
 * 必须与 native/src/mcp/servers/browser/tool_definitions.rs 的 action 表保持一致。
 */
const MERGED_TOOL_ACTIONS: Record<string, Record<string, string>> = {
  tab: {
    create: "create",
    list: "list",
    focus: "focus",
    close: "close",
    frames: "frames",
  },
  page: {
    navigate: "navigate",
    back: "back",
    forward: "forward",
    content: "get_tab_content",
    screenshot: "screenshot",
    wait: "wait",
  },
  interact: {
    click: "click",
    type: "type",
    fill_form: "fill_form",
    select_option: "select_option",
    hover: "hover",
    press_key: "press_key",
    scroll: "scroll",
    drag: "drag",
    "upload-file": "upload-file",
  },
  inspect: {
    evaluate: "evaluate",
    css_styles: "get_css_styles",
    audit: "audit",
  },
  emulate: {
    emulate: "emulate",
    resize: "resize_page",
  },
  perf: {
    trace_start: "performance_start_trace",
    trace_stop: "performance_stop_trace",
    insight: "performance_analyze_insight",
    screencast_start: "screencast_start",
    screencast_stop: "screencast_stop",
  },
  heap: {
    take: "take_heapsnapshot",
    summary: "get_heapsnapshot_summary",
    query: "query_heapsnapshot_objects",
    details: "get_heapsnapshot_object_details",
    edges: "get_heapsnapshot_edges",
    retainers: "get_heapsnapshot_retainers",
    paths: "get_heapsnapshot_retaining_paths",
    strings: "get_heapsnapshot_duplicate_strings",
    compare: "compare_heapsnapshots",
  },
  "page-tools": {
    list: "list_page_tools",
    call: "call_page_tool",
  },
};

/** 工具调用 -> 实际 operation：合并工具读 args.action，未合并工具剥掉 browser- 前缀。 */
export const resolveBrowserOperation = (
  toolName: string,
  args: unknown,
): string => {
  const shortName = toolName.startsWith("browser-")
    ? toolName.slice("browser-".length)
    : toolName;
  const actions = MERGED_TOOL_ACTIONS[shortName];
  if (!actions) return shortName;
  const rawAction =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>).action
      : undefined;
  const action = typeof rawAction === "string" ? rawAction.trim() : "";
  return actions[action] ?? shortName;
};
