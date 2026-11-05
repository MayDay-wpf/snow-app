/** 应用任务管理器：单个进程的占用快照（主进程合并 Rust 事实与 Electron 语义）。 */
export type TaskManagerProcessKind =
  "browser" | "renderer" | "gpu" | "utility" | "child";

export type TaskManagerProcess = {
  pid: number;
  parentPid: number;
  /** 可执行文件名（不含路径） */
  name: string;
  /** 可执行文件完整路径；取不到时为空串 */
  exePath: string;
  /** 系统图标（data URL）；取不到时为 null，由前端回退到通用图标 */
  iconDataUrl: string | null;
  kind: TaskManagerProcessKind;
  /** Utility 进程的服务名（如 "Network Service"），其它进程为空串 */
  serviceName: string;
  /** 渲染进程所属页面的标题，其它进程为空串 */
  title: string;
  /** 渲染进程所属页面的 URL，其它进程为空串 */
  url: string;
  /** CPU 占用百分比（按整机逻辑处理器数归一化，跑满全部核心 = 100；-1 表示本次无基线） */
  cpuPercent: number;
  memoryBytes: number;
  threadCount: number;
  /** 是否允许结束：Electron 自身进程只展示，应用派生的子进程可结束 */
  killable: boolean;
};

/** 进程采样日志设置（全局）与当前日志文件。 */
export type ProcessSamplingLogSettings = {
  /** 是否定时记录采样日志（默认关闭） */
  enabled: boolean;
  /** 采样间隔（秒，5–3600，默认 60） */
  intervalSecs: number;
};

export type ProcessSamplingLogState = ProcessSamplingLogSettings & {
  /** 当前写入的日志文件绝对路径（~/.snowapp/logs/process-sampling.jsonl） */
  filePath: string;
};

/** bash 工具 detach 启动的后台任务（Rust 内存登记表；应用重启后不保留） */
export type DetachedTaskInfo = {
  /** 任务 id：bash 工具结果里的 taskId，用于 UI 定位 */
  id: string;
  pid: number;
  command: string;
  /** 模型写的命令说明（用户语言），可能为空串 */
  description: string;
  workingDirectory: string;
  /** 任务所属项目根；无法解析时为空串（任务管理器按此过滤） */
  projectRoot: string;
  /** 输出日志绝对路径（正斜杠形式） */
  logPath: string;
  /** 启动时刻（RFC3339） */
  startedAt: string;
  /** 退出时刻（RFC3339）；仍在运行时为 null（运行时长按此定格，不随当前时间累加） */
  endedAt: string | null;
  /** 发起该命令的会话 id；非会话内启动时为 null */
  sessionId: string | null;
  /** 进程是否仍在运行（每次查询实时探测） */
  alive: boolean;
};
