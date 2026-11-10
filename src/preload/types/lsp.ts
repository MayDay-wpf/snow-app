/** LSP 服务器配置类型（与 native/src/storage/models.rs LspServerConfig* 对应）。 */

export type LspServerConfigInput = {
  /** 语言标识（唯一键，如 rust / python / go） */
  lang: string;
  /** 启动命令，如 rust-analyzer */
  command: string;
  /** 命令参数 JSON 数组字符串，如 ["--stdio"] */
  argsJson: string;
  /** 关联文件扩展名 JSON 数组字符串，如 [".rs"] */
  fileExtensionsJson: string;
  /** 安装提示命令；空值省略（napi Option<String> 不接受 null） */
  installCommand?: string | null;
  /** 初始化选项 JSON 对象字符串；空值省略（napi Option<String> 不接受 null） */
  initializationOptionsJson?: string | null;
  enabled: boolean;
  sortOrder: number;
  /** 来源：seed / legacy / manual / config-manage 等 */
  source: string;
};

export type LspServerConfigRecord = LspServerConfigInput & {
  id: string;
  updatedAt: string;
};

/** LSP 命令安装探测结果（PATH 扫描，无副作用）。 */
export type LspCommandProbeResult = {
  command: string;
  installed: boolean;
  path: string | null;
};

/** 语言服务器安装执行结果（主进程 spawn installCommand，输出截断 32KB）。 */
export type LspInstallResult = {
  command: string;
  output: string;
  exitCode: number | null;
};

/** 项目技术栈检测结果（native 扫描项目根目录，纯文件系统、无副作用）。 */
export type ProjectStackDetection = {
  /** 相对项目根的目录（"" = 根目录，如 "frontend"、"packages/web"） */
  path: string;
  /** 语言标识：typescript / rust / go / python / java / csharp / php / ruby / lua / kotlin */
  lang: string;
  /** 命中的标志文件名（package.json / Cargo.toml / go.mod 等） */
  marker: string;
};

/** 语言服务器会话运行时状态（native ServerManager 内存态快照，实时轮询用）。 */
export type LspResourcePolicy = {
  maxSessions: number;
  idleTimeoutSecs: number;
  maxConcurrentStarts: number;
};

export type LspResourceSnapshot = {
  pid: number | null;
  sampledAtMs: number;
  parentMemoryBytes: number | null;
  parentCpuSeconds: number | null;
  treeCpuSeconds: number | null;
  treeProcessCount: number | null;
};

/** 已登记物理会话的确认身份；缺少 PID 的状态不可管理。 */
export type LspSessionTarget = {
  lang: string;
  projectRoot: string;
  expectedPid: number;
  expectedRestartCount: number;
};

export type LspSessionStatus = {
  resources?: LspResourceSnapshot | null;
  /** 语言标识（rust / typescript / python ...） */
  lang: string;
  /** 会话项目根目录（绝对路径） */
  projectRoot: string;
  /** running | dead | exited（进程已退出但会话未标记） */
  status: "running" | "dead" | "exited";
  /** 会话重启次数 */
  restartCount: number;
  /** 最近使用时间（unix 毫秒） */
  lastUsedMs: number;
  /** 异常状态说明（running 时为 null） */
  error: string | null;
};
