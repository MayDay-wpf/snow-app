/**
 * 工具卡片公共词条（键前缀 remote.toolCall.common.*）。
 *
 * 覆盖：状态文案（pending / running / completed / error）、折叠按钮（展开 /
 * 收起 / 展开其余 N 行）、参数与输出标签、空态提示、字符数徽标。
 * 由 i18n/lang/tools/index.ts 聚合，展开进 lang/{en,zh-CN,zh-TW}.ts；三语同键，
 * 占位符统一 {{name}} 形式。
 */

export const commonEn: Record<string, string> = {
  // 状态
  "remote.toolCall.common.status.pending": "Waiting",
  "remote.toolCall.common.status.running": "Running",
  "remote.toolCall.common.status.completed": "Done",
  "remote.toolCall.common.status.error": "Failed",

  // 折叠
  "remote.toolCall.common.expand": "Expand",
  "remote.toolCall.common.collapse": "Collapse",
  "remote.toolCall.common.expandLines": "Show {{count}} more lines",

  // 提示
  "remote.toolCall.common.noArgs": "No arguments",
  "remote.toolCall.common.empty": "No arguments or output",

  // 分区标签与徽标
  "remote.toolCall.common.arguments": "Arguments",
  "remote.toolCall.common.result": "Result",
  "remote.toolCall.common.stdout": "Output",
  "remote.toolCall.common.stderr": "Standard error",
  "remote.toolCall.common.charCount": "{{count}} chars",
};

export const commonZhCN: Record<string, string> = {
  // 状态
  "remote.toolCall.common.status.pending": "等待",
  "remote.toolCall.common.status.running": "执行中",
  "remote.toolCall.common.status.completed": "完成",
  "remote.toolCall.common.status.error": "失败",

  // 折叠
  "remote.toolCall.common.expand": "展开",
  "remote.toolCall.common.collapse": "收起",
  "remote.toolCall.common.expandLines": "展开其余 {{count}} 行",

  // 提示
  "remote.toolCall.common.noArgs": "无参数",
  "remote.toolCall.common.empty": "无参数与输出",

  // 分区标签与徽标
  "remote.toolCall.common.arguments": "参数",
  "remote.toolCall.common.result": "结果",
  "remote.toolCall.common.stdout": "输出",
  "remote.toolCall.common.stderr": "标准错误",
  "remote.toolCall.common.charCount": "{{count}} 字符",
};

export const commonZhTW: Record<string, string> = {
  // 狀態
  "remote.toolCall.common.status.pending": "等待",
  "remote.toolCall.common.status.running": "執行中",
  "remote.toolCall.common.status.completed": "完成",
  "remote.toolCall.common.status.error": "失敗",

  // 折疊
  "remote.toolCall.common.expand": "展開",
  "remote.toolCall.common.collapse": "收合",
  "remote.toolCall.common.expandLines": "展開其餘 {{count}} 行",

  // 提示
  "remote.toolCall.common.noArgs": "無參數",
  "remote.toolCall.common.empty": "無參數與輸出",

  // 分區標籤與徽章
  "remote.toolCall.common.arguments": "參數",
  "remote.toolCall.common.result": "結果",
  "remote.toolCall.common.stdout": "輸出",
  "remote.toolCall.common.stderr": "標準錯誤",
  "remote.toolCall.common.charCount": "{{count}} 字元",
};
