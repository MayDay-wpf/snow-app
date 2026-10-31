const { existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const nativeDir = __dirname;

const platformMap = {
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
  "darwin-x64": ["darwin-universal", "darwin-x64"],
  "darwin-arm64": ["darwin-universal", "darwin-arm64"],
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
};

// 当前主进程代码实际调用的 native 导出（最小必需集）。
// 缺任意一个即视为绑定过旧/损坏，必须跳过换下一个候选，否则运行期
// 会以 "xxx is not a function" 崩溃（例如 2026-08 LSP 会话状态徽章事故：
// 旧绑定缺 listLspSessionStatuses 却通过校验被加载）。
const requiredExports = [
  // 核心存储与会话
  "initializeAppStorage",
  // 对话请求代理层（用户脚本 onRequest / onResponseEvent 回调注册）
  "setRequestProxyHandler",
  "listCustomHeaderSchemes",
  "upsertCustomHeaderScheme",
  "deleteCustomHeaderScheme",
  "reorderWorkspaceDirectories",
  "deleteWorkspaceDirectory",
  // 关联项目组颜色（合集统一圆点标识）
  "updateProjectCollectionColor",
  // 关联项目组成员开关（断连后仍留在合集里）
  "setProjectCollectionMemberLinked",
  "listCheckpointSummariesBatch",
  "restoreCheckpoints",
  "listCheckpointChangesBatch",
  "readCheckpointDiffPage",
  "migrateCheckpointLayout",
  "listChatMessagesPaginated",
  // 应用锁：允许用身份验证器动态码解锁手机远控
  "setAppLockRemoteUnlock",
  // 本地数据清理（设置 → 存储与资源 → 数据清理）
  "scanCleanup",
  "deleteCleanupData",
  // LSP 服务器配置与会话状态（配置中心 / 状态徽章轮询）
  "getLspResourcePolicy",
  "setLspResourcePolicy",
  "listLspServerConfigs",
  "upsertLspServerConfig",
  "deleteLspServerConfig",
  "listProjectLspServerConfigs",
  "upsertProjectLspServerConfig",
  "deleteProjectLspServerConfig",
  "listEffectiveLspServerConfigs",
  "probeLspServerCommands",
  "detectProjectStack",
  "listLspSessionStatuses",
  // 任务管理器精准物理会话管理（拒绝缺少新接口的旧绑定）
  "manageLspSession",
  // 工作区条目 / 用量统计 / 计划任务
  // （历史会话引用已改为 @@conversation: 内联标签，不再需要附件表导出）
  "deleteWorkspaceEntries",
  "gitFileContent",
  // 克隆 Git 仓库的中止入口（克隆进行中杀进程树 + 清理半成品目录）
  "cancelGitClone",
  "listScheduledTasks",
  "upsertScheduledTask",
  "deleteScheduledTask",
  "clearScheduledTasks",
  "appendScheduledTaskRun",
  "finalizeScheduledTaskRun",
  "reconcileScheduledTaskRuns",
  // 定时任务「关闭后仍执行」的系统级唤醒注册
  "syncScheduledWake",
  // 历史会话引用 chip 悬停预览（@@conversation: 标签注入内容预览）
  "previewConversationAttachment",
  // Markdown 表格导出（CSV / XLSX 字节由 Rust 生成）
  "exportMarkdownTable",
  // 项目级持久记忆（Project Memory：MCP 工具 + 面板 + 会话删除联动）
  "upsertProjectMemory",
  "listProjectMemories",
  "updateProjectMemory",
  "deleteProjectMemory",
  "clearProjectMemories",
  "getProjectMemoryStats",
  "countProjectMemoriesByConversations",
  // 记忆来源会话解析（含子代理 / WorkFlow 节点会话，供「来自会话」徽章跳转）
  "listMemorySourceConversations",
  // MCP 设置面板保存链路（快速列表：只读发现缓存，保存不再等全量工具发现）
  "listMcpProjectServersCached",
  // 全局子代理工具目录（不依赖项目）
  "listMcpGlobalServers",
  // 子代理白名单不可用工具诊断
  "diagnoseSubAgentTools",
  // 敏感命令决策模型辅助（拦截提示展示判定 / 托管执行）
  "evaluateSensitiveCommandDecision",
  // 决策 / 嵌入 / 重排模型连接自检与失败可见性（配置页测试连接、索引失败回看、日志模块筛选）
  "testDecisionModelConnection",
  "testEmbeddingConnection",
  "testRerankingConnection",
  "getModelHealthSnapshot",
  "getLastCodebaseEmbedFailure",
  "listAppLogModules",
  // 手机远控（原生 HTTP 服务 / 鉴权 / 附件）
  "setRemoteControlRendererBridge",
  "startRemoteControlServer",
  "stopRemoteControlServer",
  "getRemoteControlServerState",
  "setRemoteControlLanToken",
  "setRemoteControlWanToken",
  "startRemoteWanListener",
  "stopRemoteWanListener",
  "resolveRemoteAttachments",
  // 团队协作：自定义头像颜色（写入 git config snow.avatarColor）
  "teamSetAvatarColor",
  // 退出前落盘尚未执行的自动格式化（延迟格式化调度器，见 filesystem/format.rs）
  "flushPendingFileFormats",
  // 内置浏览器访问历史（地址栏补全 / 设置页历史管理）
  "browserHistoryRecord",
  "browserHistoryUpdateTitle",
  "browserHistorySearch",
  "browserHistoryList",
  "browserHistoryDelete",
  "browserHistoryClear",
  // 系统日志自动清理（保留期设置与按保留期清理）
  "getAppLogsRetentionDays",
  "setAppLogsRetentionDays",
  "pruneAppLogs",
  // 插件市场（索引拉取 / 从市场安装插件与脚本）
  "fetchPluginRegistry",
  "fetchPluginMarketStats",
  "installPluginFromMarket",
  "installScriptFromMarket",
  // OAuth 登录（API 设置 → LLM 模型 → OAuth 登录；provider 由后端注册，可扩展）
  "listOAuthProviders",
  "startOAuthLogin",
  "getOAuthLoginStatus",
  "submitOAuthCallback",
  "cancelOAuthLogin",
  // OAuth 登录插件（主进程宿主回调与 provider 声明推送）
  "setOAuthPluginHandler",
  "setOAuthPluginProviders",
  // OAuth 插件钩子内管理自定义请求头方案
  "upsertOAuthPluginHeaderScheme",
  "bindOAuthPluginHeaderScheme",
  "deleteOAuthPluginHeaderScheme",
  // OAuth 插件 fetch 钩子的流式正文（主进程逐块推给 Rust）
  "pushOAuthPluginStreamChunk",
  "endOAuthPluginStream",
  // OAuth 订阅配额（模型列表配额面板）
  "getOAuthQuota",
  // 异步生图任务生命周期与持久批次通知（拒绝缺少新接口的旧绑定）
  "registerImageGenerationBatch",
  "sealImageGenerationBatch",
  "listImageGenerationBatches",
  "getImageGenerationTask",
  "claimImageGenerationBatchNotification",
  "releaseImageGenerationBatchNotification",
  "recoverInterruptedImageGenerationTasks",
  // 应用任务管理器（进程树快照采集与结束进程）
  "listProcessTree",
  "killProcessTree",
  // 内置浏览器 UA 对齐本机真实浏览器（读取 Chrome/Edge 版本号）
  "detectLocalBrowserVersion",
];

const platformName = platformMap[`${process.platform}-${process.arch}`];
const nodeFiles = readdirSync(nativeDir)
  .filter((file) => file.endsWith(".node"))
  .map((file) => join(nativeDir, file));

const platformNames = platformName
  ? Array.isArray(platformName)
    ? platformName
    : [platformName]
  : [];
const platformCandidates = platformNames.length
  ? nodeFiles
      .filter((file) =>
        platformNames.some((name) => file.includes(`snow_native.${name}`)),
      )
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  : [];

const candidates = [
  ...platformCandidates,
  ...nodeFiles.filter((file) => !platformCandidates.includes(file)),
];

const loadErrors = [];
let nativeBinding = null;

for (const candidate of candidates) {
  if (!existsSync(candidate)) {
    continue;
  }

  try {
    const binding = require(candidate);
    const missingExports = requiredExports.filter(
      (exportName) => typeof binding[exportName] !== "function",
    );

    if (missingExports.length > 0) {
      loadErrors.push(
        new Error(
          `${candidate} is missing native exports: ${missingExports.join(", ")}`,
        ),
      );
      continue;
    }

    nativeBinding = binding;
    break;
  } catch (error) {
    loadErrors.push(error);
  }
}

if (!nativeBinding) {
  const hint =
    loadErrors.length > 0
      ? ` Last error: ${loadErrors[loadErrors.length - 1].message}`
      : "";
  throw new Error(
    `Unable to locate compiled snow_native *.node binding. Run npm run build:rust.${hint}`,
  );
}

module.exports = nativeBinding;
