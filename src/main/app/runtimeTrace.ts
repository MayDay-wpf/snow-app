import { app, powerMonitor } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 进程级运行时追踪：无论正常退出、异常退出还是被外部终止，都留下可判读的
// 时间线。与 snowLog（异步写 SQLite，进程退出瞬间会丢）互补，这里全部使用
// 同步文件写入，保证 exit 钩子内的记录一定落盘。
//
// 产物（~/.snowapp/logs/）：
// - runtime-trace.jsonl    追加式事件线：session-start / quit-start /
//   process-exit / main-stall-recovered / window-* / renderer-gone 等
// - runtime-heartbeat.json 覆盖写的心跳（5 秒一次），进程被硬杀时它的
//   时间戳就是最后存活证明
//
// 判读要点：
// - 有 process-exit 且 quitRequested=true → 走了正常退出链路
// - 无 process-exit 且 heartbeat 停在 T → 进程在 T 之后被硬杀或崩溃
//   （配合 Crashpad 转储 / Windows 事件日志判断具体死法）
// - main-stall-recovered → 主进程消息泵曾卡死超过 5 秒后恢复；
//   stalledMs 巨大且伴随 system-suspend/resume 的是系统睡眠

const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_FLUSH_INTERVAL_MS = 5000;
const STALL_THRESHOLD_MS = 5000;
const MAX_TRACE_BYTES = 2 * 1024 * 1024;

const startedAt = Date.now();
let traceFile: string | null = null;
let lastBeatAt = Date.now();
let quitRequested = false;

const pad = (value: number, width = 2): string =>
  String(value).padStart(width, "0");

const formatLocalTime = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;

// 进程自身内存（rss/堆/外部）+ 系统物理内存水位，全部同步获取，
// 可安全用于 exit 钩子。
const memSnapshot = (): Record<string, number> => {
  const mem = process.memoryUsage();
  return {
    rssMB: Math.round(mem.rss / 1048576),
    heapUsedMB: Math.round(mem.heapUsed / 1048576),
    externalMB: Math.round(mem.external / 1048576),
    physFreeMB: Math.round(os.freemem() / 1048576),
    physTotalMB: Math.round(os.totalmem() / 1048576),
  };
};

// 同步追加一条事件。追踪自身的任何失败都被吞掉：诊断通道绝不能成为
// 新的故障点，也不能影响退出流程本身。
export const appendTrace = (event: Record<string, unknown>): void => {
  const target = traceFile;
  if (!target) return;
  try {
    try {
      if (fs.statSync(target).size > MAX_TRACE_BYTES) {
        fs.renameSync(target, `${target}.1`);
      }
    } catch {
      // 文件尚不存在时 statSync 抛错属预期，直接进入追加。
    }
    const line = `${JSON.stringify({
      t: formatLocalTime(new Date()),
      pid: process.pid,
      ...event,
    })}\n`;
    fs.appendFileSync(target, line);
  } catch {
    // 同上，静默。
  }
};

// 在单实例锁拿到之后立即调用（bootstrapApplication 内）：此后的退出、
// 卡死、窗口销毁都会留下记录；拿锁失败的第二实例不初始化、零日志静默退出。
export const initRuntimeTrace = (): void => {
  const dir = path.join(app.getPath("home"), ".snowapp", "logs");
  fs.mkdirSync(dir, { recursive: true });
  traceFile = path.join(dir, "runtime-trace.jsonl");
  const hbFile = path.join(dir, "runtime-heartbeat.json");

  appendTrace({
    ev: "session-start",
    version: app.getVersion(),
    electron: process.versions.electron,
    mem: memSnapshot(),
  });

  // 卡死检测：interval 与消息泵同线程，主进程卡死时它同样停摆，
  // 恢复后第一个 tick 的 gap 就是卡死时长。
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastBeatAt;
    lastBeatAt = now;
    if (gap > STALL_THRESHOLD_MS) {
      appendTrace({
        ev: "main-stall-recovered",
        stalledMs: Math.round(gap),
        mem: memSnapshot(),
      });
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 心跳覆盖写：进程无论怎么死，该文件的时间戳就是最后存活时刻。
  setInterval(() => {
    try {
      fs.writeFileSync(
        hbFile,
        JSON.stringify({
          t: formatLocalTime(new Date()),
          pid: process.pid,
          mem: memSnapshot(),
        }),
      );
    } catch {
      // 同 appendTrace，静默。
    }
  }, HEARTBEAT_FLUSH_INTERVAL_MS);

  app.on("before-quit", () => {
    quitRequested = true;
    appendTrace({ ev: "quit-start" });
  });

  // powerMonitor 要求 app ready 之后才能绑定事件。
  void app.whenReady().then(() => {
    powerMonitor.on("suspend", () => appendTrace({ ev: "system-suspend" }));
    powerMonitor.on("resume", () =>
      appendTrace({ ev: "system-resume", mem: memSnapshot() }),
    );
  });

  // Node exit 钩子：覆盖 app.quit / process.exit 等干净退出路径。
  // 硬杀（TerminateProcess）与 native 崩溃不会触发本钩子——那种情况
  // 由 heartbeat 停摆 + 无 process-exit 行来判定。
  process.on("exit", (code) => {
    appendTrace({
      ev: "process-exit",
      exitCode: code,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      quitRequested,
      lastHeartbeatAgoMs: Date.now() - lastBeatAt,
      mem: memSnapshot(),
    });
  });
};
