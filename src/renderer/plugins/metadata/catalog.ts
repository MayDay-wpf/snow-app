import type { Locale } from "../../../shared/locale";

export type MetadataDomainGroupId =
  "appearance" | "ai" | "content" | "project" | "connectivity" | "other";

export const METADATA_DOMAIN_GROUP_IDS: MetadataDomainGroupId[] = [
  "appearance",
  "ai",
  "content",
  "project",
  "connectivity",
  "other",
];

export type MetadataDomainCatalogEntry = {
  group: MetadataDomainGroupId;
  params: string[];
  summary: Record<Locale, string>;
};

const FALLBACK_ENTRY: MetadataDomainCatalogEntry = {
  group: "other",
  params: [],
  summary: { en: "", "zh-CN": "", "zh-TW": "" },
};

export const METADATA_DOMAIN_CATALOG: Record<
  string,
  MetadataDomainCatalogEntry
> = {
  app: {
    group: "appearance",
    params: [],
    summary: {
      en: "Version, updates, engine, storage locations, environment info",
      "zh-CN": "版本、更新、引擎、存储位置与运行环境信息",
      "zh-TW": "版本、更新、引擎、儲存位置與執行環境資訊",
    },
  },
  theme: {
    group: "appearance",
    params: [],
    summary: {
      en: "Theme mode, palettes, font, background, stream cursor",
      "zh-CN": "主题模式、调色板、字体、背景与流式光标",
      "zh-TW": "主題模式、調色盤、字型、背景與串流游標",
    },
  },
  processes: {
    group: "other",
    params: [],
    summary: {
      en: "Task manager process tree: roles, CPU, memory, threads, child processes",
      "zh-CN": "任务管理器进程树：进程角色、CPU、内存、线程与派生子进程",
      "zh-TW": "工作管理員行程樹：行程角色、CPU、記憶體、執行緒與衍生子行程",
    },
  },
  settings: {
    group: "appearance",
    params: ["conversationId"],
    summary: {
      en: "App switches, shortcuts, conversation modes, Git scan",
      "zh-CN": "应用开关、快捷键、会话模式与运行参数、Git 扫描",
      "zh-TW": "應用開關、快速鍵、工作階段模式與執行參數、Git 掃描",
    },
  },
  privacy: {
    group: "appearance",
    params: [],
    summary: {
      en: "Privacy filter switch, mode and API configuration",
      "zh-CN": "隐私过滤开关、模式与 API 配置",
      "zh-TW": "隱私過濾開關、模式與 API 設定",
    },
  },
  permissions: {
    group: "appearance",
    params: ["projectId"],
    summary: {
      en: "Approval lists, read-only tools, sensitive command rules",
      "zh-CN": "工具放行清单、只读工具与敏感命令规则",
      "zh-TW": "工具放行清單、唯讀工具與敏感指令規則",
    },
  },
  ide: {
    group: "appearance",
    params: [],
    summary: {
      en: "IDEs available for “open in editor”",
      "zh-CN": "可用于「在编辑器中打开」的 IDE 列表",
      "zh-TW": "可用於「在編輯器中開啟」的 IDE 清單",
    },
  },
  pets: {
    group: "appearance",
    params: [],
    summary: {
      en: "Installed pets and pet window settings",
      "zh-CN": "已安装桌宠与桌宠窗口设置",
      "zh-TW": "已安裝桌寵與桌寵視窗設定",
    },
  },
  plugins: {
    group: "appearance",
    params: [],
    summary: {
      en: "Installed plugin inventory",
      "zh-CN": "已安装插件清单",
      "zh-TW": "已安裝外掛清單",
    },
  },
  apiProfiles: {
    group: "ai",
    params: [],
    summary: {
      en: "API profiles (keys stripped)",
      "zh-CN": "API 档案（密钥已剥离）",
      "zh-TW": "API 設定檔（金鑰已剝離）",
    },
  },
  apiModels: {
    group: "ai",
    params: ["profileName"],
    summary: {
      en: "Live model list fetched from one API profile's provider",
      "zh-CN": "从服务商实时拉取的单个 API 档案模型清单",
      "zh-TW": "從服務商即時取得的單一 API 設定檔模型清單",
    },
  },
  systemPrompts: {
    group: "ai",
    params: [],
    summary: {
      en: "System prompt entries",
      "zh-CN": "系统提示词条目",
      "zh-TW": "系統提示詞項目",
    },
  },
  customHeaders: {
    group: "ai",
    params: [],
    summary: {
      en: "Custom request-header schemes",
      "zh-CN": "自定义请求头方案",
      "zh-TW": "自訂請求標頭方案",
    },
  },
  personalization: {
    group: "ai",
    params: [],
    summary: {
      en: "The global ROLE rules file",
      "zh-CN": "全局 ROLE 规则文件",
      "zh-TW": "全域 ROLE 規則檔案",
    },
  },
  mcp: {
    group: "ai",
    params: ["projectId"],
    summary: {
      en: "MCP servers, tools and project-level state",
      "zh-CN": "MCP 服务器、工具与项目级状态",
      "zh-TW": "MCP 伺服器、工具與專案層級狀態",
    },
  },
  subAgents: {
    group: "ai",
    params: ["projectId"],
    summary: {
      en: "Sub-agent configurations",
      "zh-CN": "子代理配置",
      "zh-TW": "子代理設定",
    },
  },
  hooks: {
    group: "ai",
    params: ["projectId"],
    summary: {
      en: "Global and project-level hooks",
      "zh-CN": "全局与项目级 Hooks",
      "zh-TW": "全域與專案層級 Hooks",
    },
  },
  skills: {
    group: "ai",
    params: ["projectId"],
    summary: {
      en: "Available Skills and project overrides",
      "zh-CN": "可用 Skills 与项目覆盖",
      "zh-TW": "可用 Skills 與專案覆寫",
    },
  },
  lsp: {
    group: "ai",
    params: ["projectId"],
    summary: {
      en: "LSP servers, effective config and session states",
      "zh-CN": "LSP 服务器、生效配置与会话状态",
      "zh-TW": "LSP 伺服器、生效設定與工作階段狀態",
    },
  },
  conversations: {
    group: "content",
    params: ["directoryId"],
    summary: {
      en: "Project conversation list and the focused conversation",
      "zh-CN": "项目会话列表与焦点会话",
      "zh-TW": "專案工作階段清單與焦點工作階段",
    },
  },
  messages: {
    group: "content",
    params: ["conversationId"],
    summary: {
      en: "Messages, including thinking and tool-call JSON",
      "zh-CN": "会话消息（含思维链与工具调用 JSON）",
      "zh-TW": "工作階段訊息（含思維鏈與工具呼叫 JSON）",
    },
  },
  runtime: {
    group: "content",
    params: [],
    summary: {
      en: "Live runtime snapshot (conversation, chat input, streaming, panels, projects)",
      "zh-CN": "实时运行时快照（会话、输入框内容、流式指标、面板、项目）",
      "zh-TW": "即時執行期快照（工作階段、輸入框內容、串流指標、面板、專案）",
    },
  },
  interactions: {
    group: "content",
    params: [],
    summary: {
      en: "Pending tool authorizations and questions of the active conversation",
      "zh-CN": "当前激活会话中待处理的工具授权与提问",
      "zh-TW": "目前啟用工作階段中待處理的工具授權與提問",
    },
  },
  panels: {
    group: "content",
    params: [],
    summary: {
      en: "Right-panel tab state",
      "zh-CN": "右侧面板标签状态",
      "zh-TW": "右側面板分頁狀態",
    },
  },
  memos: {
    group: "content",
    params: ["directoryId", "limit", "offset"],
    summary: {
      en: "Memo entries and counts",
      "zh-CN": "备忘录条目与计数",
      "zh-TW": "備忘錄項目與計數",
    },
  },
  memory: {
    group: "content",
    params: ["directoryId", "limit", "offset"],
    summary: {
      en: "Project memory entries and statistics",
      "zh-CN": "项目记忆条目与统计",
      "zh-TW": "專案記憶項目與統計",
    },
  },
  scheduledTasks: {
    group: "content",
    params: [],
    summary: {
      en: "Scheduled task definitions and run state",
      "zh-CN": "定时任务定义与运行状态",
      "zh-TW": "排程任務定義與執行狀態",
    },
  },
  usage: {
    group: "content",
    params: ["since", "until", "profileName", "limit", "offset"],
    summary: {
      en: "Usage summary, daily and per-model breakdowns, records",
      "zh-CN": "用量汇总、日/模型维度与明细",
      "zh-TW": "用量彙總、每日與模型維度及明細",
    },
  },
  logs: {
    group: "content",
    params: ["level", "module", "since", "until", "limit", "offset"],
    summary: {
      en: "Paged application logs",
      "zh-CN": "系统日志分页",
      "zh-TW": "系統日誌分頁",
    },
  },
  projects: {
    group: "project",
    params: ["directoryId"],
    summary: {
      en: "Project list, collections, relinks and the active project",
      "zh-CN": "项目列表、合集、迁移记录与激活项目",
      "zh-TW": "專案清單、合集、遷移紀錄與使用中專案",
    },
  },
  git: {
    group: "project",
    params: ["projectPath", "projectId"],
    summary: {
      en: "Repository status, branches and repo identity",
      "zh-CN": "仓库状态、分支与仓库身份",
      "zh-TW": "儲存庫狀態、分支與倉庫身分",
    },
  },
  codebase: {
    group: "project",
    params: ["projectId", "page", "pageSize"],
    summary: {
      en: "Index scope, stats, indexed files and resumable sessions",
      "zh-CN": "代码库索引范围、统计、文件与断点会话",
      "zh-TW": "程式碼庫索引範圍、統計、檔案與續傳工作階段",
    },
  },
  ssh: {
    group: "connectivity",
    params: ["directoryId"],
    summary: {
      en: "SSH credentials, config hosts and remote drafts",
      "zh-CN": "SSH 凭据、config 主机与远程草稿",
      "zh-TW": "SSH 憑證、config 主機與遠端草稿",
    },
  },
  remoteControl: {
    group: "connectivity",
    params: [],
    summary: {
      en: "Mobile pairing state and tunnel status",
      "zh-CN": "手机远控配对状态与隧道状态",
      "zh-TW": "手機遠端控制配對狀態與通道狀態",
    },
  },
  browser: {
    group: "connectivity",
    params: [],
    summary: {
      en: "Passwords, bookmarks, downloads and import sources",
      "zh-CN": "浏览器密码、书签、下载与导入来源",
      "zh-TW": "瀏覽器密碼、書籤、下載與匯入來源",
    },
  },
  userscripts: {
    group: "connectivity",
    params: [],
    summary: {
      en: "Userscript inventory",
      "zh-CN": "油猴脚本清单",
      "zh-TW": "使用者腳本清單",
    },
  },
  imageLibrary: {
    group: "connectivity",
    params: [],
    summary: {
      en: "Library images, albums and root directory",
      "zh-CN": "图库图片、相册与目录",
      "zh-TW": "圖庫圖片、相簿與目錄",
    },
  },
};

export const resolveMetadataDomainEntry = (
  domainId: string,
): MetadataDomainCatalogEntry =>
  METADATA_DOMAIN_CATALOG[domainId] ?? FALLBACK_ENTRY;
