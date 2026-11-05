/**
 * 进程采样日志：全局定时采样，独立于任务管理器面板运行。
 *
 * 每个周期追加一行 JSONL 到 ~/.snowapp/logs/process-sampling.jsonl，
 * 内容含汇总、全部进程明细（含 Electron 角色与页面标签）、LSP 会话与资源预算。
 * 超过单文件上限由 Rust 侧轮转，只保留最近若干文件。
 */
import { app } from "electron";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeBridge } from "../native/types";
import { snowLog } from "../../utils/snowLogger";
import { sampleProcessRowsForLog } from "./processSnapshot";
import {
  DEFAULT_SAMPLING_LOG_SETTINGS,
  loadSamplingLogSettings,
  parseSamplingLogInput,
  saveSamplingLogSettings,
  type ProcessSamplingLogSettings,
} from "./processSamplingLogSettings";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 文件总数上限（含当前文件）：约 50 MB */
const MAX_FILE_COUNT = 10;
const MODULE_TAG = "monitoring/processSamplingLog";
/** 当前写入的文件名，与 native/src/storage/process_sampling_log.rs 的 ACTIVE_FILE_NAME 一致 */
const ACTIVE_FILE_NAME = "process-sampling.jsonl";

export type ProcessSamplingLogState = ProcessSamplingLogSettings & {
  /** 当前写入的日志文件绝对路径（~/.snowapp/logs/process-sampling.jsonl） */
  filePath: string;
};

type ProcessRow = Awaited<ReturnType<typeof sampleProcessRowsForLog>>[number];

let nativeRef: NativeBridge | null = null;
let settings: ProcessSamplingLogSettings = { ...DEFAULT_SAMPLING_LOG_SETTINGS };
let timer: ReturnType<typeof setTimeout> | null = null;
let sampling = false;
let sequence = 0;
let writeFailing = false;

const samplingLogDirectory = (): string =>
  path.join(app.getPath("home"), ".snowapp", "logs");

/** 当前日志文件路径：供界面直接展示具体文件，避免用户只知道目录。 */
const getSamplingLogFilePath = (): string =>
  path.join(samplingLogDirectory(), ACTIVE_FILE_NAME);

const round2 = (value: number): number => Math.round(value * 100) / 100;

const clearTimer = (): void => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
};

const scheduleNext = (delayMs: number): void => {
  clearTimer();
  timer = setTimeout(() => {
    timer = null;
    void runSample();
  }, delayMs);
};

/** 汇总：CPU 只累加有基线的进程（-1 视为无基线），并按进程角色分组统计。 */
const summarize = (rows: ProcessRow[]) => {
  let cpuPercent = 0;
  let cpuSampledCount = 0;
  let memoryBytes = 0;
  let threadCount = 0;
  const byKind: Record<
    string,
    { count: number; cpuPercent: number; memoryBytes: number }
  > = {};
  for (const row of rows) {
    const sampled = row.cpuPercent >= 0;
    const cpu = sampled ? row.cpuPercent : 0;
    if (sampled) {
      cpuPercent += cpu;
      cpuSampledCount += 1;
    }
    memoryBytes += row.memoryBytes;
    threadCount += row.threadCount;
    const bucket = (byKind[row.kind] ??= {
      count: 0,
      cpuPercent: 0,
      memoryBytes: 0,
    });
    bucket.count += 1;
    bucket.cpuPercent += cpu;
    bucket.memoryBytes += row.memoryBytes;
  }
  for (const bucket of Object.values(byKind)) {
    bucket.cpuPercent = round2(bucket.cpuPercent);
  }
  return {
    processCount: rows.length,
    cpuSampledCount,
    cpuPercent: round2(cpuPercent),
    memoryBytes,
    threadCount,
    byKind,
  };
};

const toLogRow = (row: ProcessRow) => ({
  pid: row.pid,
  ppid: row.parentPid,
  name: row.name,
  kind: row.kind,
  serviceName: row.serviceName,
  title: row.title,
  url: row.url,
  exePath: row.exePath,
  /** -1 表示本次无 CPU 基线 */
  cpuPercent: row.cpuPercent >= 0 ? round2(row.cpuPercent) : -1,
  memoryBytes: row.memoryBytes,
  threadCount: row.threadCount,
});

/** LSP 会话与资源预算；失败只记录错误，不影响进程明细的落盘。 */
const sampleLspSection = async (native: NativeBridge) => {
  try {
    const [policy, sessions] = await Promise.all([
      native.getLspResourcePolicy(),
      native.listLspSessionStatuses(),
    ]);
    return {
      ok: true,
      error: null as string | null,
      policy: JSON.parse(policy) as unknown,
      sessions,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      policy: null,
      sessions: [],
    };
  }
};

const writeSample = async (
  native: NativeBridge,
  intervalSecs: number,
): Promise<void> => {
  const startedAt = Date.now();
  const rows = await sampleProcessRowsForLog(native);
  const lsp = await sampleLspSection(native);
  const collectMs = Date.now() - startedAt;
  sequence += 1;
  const record = {
    seq: sequence,
    t: new Date(startedAt).toISOString(),
    ts: startedAt,
    intervalSecs,
    collectMs,
    cores: os.availableParallelism(),
    summary: summarize(rows),
    processes: rows.map(toLogRow),
    lsp,
  };
  await native.appendProcessSamplingLog(
    samplingLogDirectory(),
    JSON.stringify(record),
    MAX_FILE_BYTES,
    MAX_FILE_COUNT,
  );
};

const runSample = async (): Promise<void> => {
  if (sampling || !nativeRef || !settings.enabled) return;
  sampling = true;
  const startedAt = Date.now();
  try {
    await writeSample(nativeRef, settings.intervalSecs);
    writeFailing = false;
  } catch (error) {
    if (!writeFailing) {
      writeFailing = true;
      snowLog.warn({
        module: MODULE_TAG,
        func: "runSample",
        message: "Failed to write process sampling log",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    sampling = false;
    // 定时器在采样期间被设置变更重建时已存在，这里不重复调度。
    if (settings.enabled && timer === null) {
      scheduleNext(
        Math.max(0, settings.intervalSecs * 1000 - (Date.now() - startedAt)),
      );
    }
  }
};

const applySettings = (next: ProcessSamplingLogSettings): void => {
  settings = next;
  clearTimer();
  if (!settings.enabled || !nativeRef) return;
  // 开启或修改后立即采样一次；采样进行中则由其结束时调度。
  if (!sampling) scheduleNext(0);
};

/** 启动时读取持久化设置并按需开始采样（应在存储就绪后调用）。 */
export const initProcessSamplingLog = async (
  native: NativeBridge,
): Promise<void> => {
  nativeRef = native;
  applySettings(await loadSamplingLogSettings(native));
};

export const readProcessSamplingLog = async (
  native: NativeBridge,
): Promise<ProcessSamplingLogState> => ({
  ...(await loadSamplingLogSettings(native)),
  filePath: getSamplingLogFilePath(),
});

export const updateProcessSamplingLog = async (
  native: NativeBridge,
  input: unknown,
): Promise<ProcessSamplingLogState> => {
  const next = parseSamplingLogInput(input);
  await saveSamplingLogSettings(native, next);
  nativeRef = native;
  applySettings(next);
  return { ...next, filePath: getSamplingLogFilePath() };
};
