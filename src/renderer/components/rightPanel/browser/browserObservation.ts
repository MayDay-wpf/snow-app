/**
 * 浏览器动作的「动作后观察」。
 *
 * 动作派发后在本渲染进程内做一次有界观察：安装一次轻量探针（MutationObserver
 * + 文档身份），在限定时间窗内轮询 URL / 标题 / DOM 变化，并汇总本次动作
 * 产生的事件（控制台错误、JS 弹窗、下载）。
 *
 * 设计约束（issue #236）：
 * - 不等待 network-idle，只做有界观察；窗口结束仍无变化时明确返回 unchanged；
 * - 事件按本次动作的时间窗口取增量，不清空共享日志，多个消费者互不影响；
 * - 观察超时 / 页面切换中 / 被弹窗阻塞 与动作本身是否成功严格区分，
 *   动作绝不隐式重试；调用方要更强的完成条件时用 expect 显式等待。
 */

const PROBE_KEY = "__snowActionResultProbe";

/** 观察窗口：默认 1500ms；带 expect 时默认 5000ms。 */
const DEFAULT_OBSERVE_TIMEOUT_MS = 1_500;
const DEFAULT_EXPECT_TIMEOUT_MS = 5_000;
const MIN_OBSERVE_TIMEOUT_MS = 100;
const MAX_OBSERVE_TIMEOUT_MS = 10_000;
/** 轮询间隔与检测到变化后的稳定等待（让渲染/标题更新落地）。 */
const POLL_INTERVAL_MS = 100;
const SETTLE_MS = 150;
/** 单次探针脚本预算：超过视为页面脚本不可响应（导航中或被弹窗阻塞）。 */
const PROBE_TIMEOUT_MS = 1_200;
/** 派发前安装探针的预算：页面被弹窗阻塞时不要拖慢派发。 */
const PROBE_INSTALL_TIMEOUT_MS = 600;
/** snapshot 模式返回的正文长度上限（随后仍会经过文本脱敏）。 */
const SNAPSHOT_TEXT_LENGTH = 4_000;
const MAX_CONSOLE_ERRORS = 5;

type BrowserObserveMode = "none" | "brief" | "snapshot";

export type BrowserObservationExpect = {
  urlIncludes?: string;
  selector?: string;
  text?: string;
};

export type BrowserObservationRequest = {
  mode: Exclude<BrowserObserveMode, "none">;
  timeoutMs: number;
  expect?: BrowserObservationExpect;
};

/** 目标帧内的观察结果；error 表示帧已失效或 CDP 不可用。 */
type FrameObservation = {
  url?: string;
  title?: string;
  matches?: boolean;
  text?: string;
  error?: string;
};

export type BrowserObservationStatus =
  "changed" | "unchanged" | "navigating" | "blocked" | "expect-timeout";

export type BrowserActionObservation = {
  mode: "brief" | "snapshot";
  /** 带 frameId 的动作：expect 在目标帧内评估，其余信号仍来自顶层页面。 */
  scope?: "frame";
  frame?: FrameObservation;
  status: BrowserObservationStatus;
  waitedMs: number;
  changes: string[];
  probe?: "unresponsive";
  expect?: { conditions: string[]; satisfied: boolean };
  events?: {
    dialogsPending: number;
    dialogsOpened: number;
    downloadsStarted: number;
    consoleErrors: { message: string; source?: string; line?: number }[];
  };
  state?: {
    readyState: string;
    searchFields?: { field: string; value: string }[];
  };
  text?: string;
  note: string;
};

const STATUS_NOTES: Record<BrowserObservationStatus, string> = {
  changed:
    "Observed after a bounded wait (no network-idle wait); verify the business outcome before repeating a side-effecting action.",
  unchanged:
    "No observable page change in the observation window. The action was dispatched, which does not prove the page handled it; verify with browser-devtools snapshot or browser-wait instead of repeating it.",
  navigating:
    "The page was still loading when the observation window closed; wait for a concrete condition (browser-wait) or take a snapshot instead of treating this as a failed action.",
  blocked:
    "A JavaScript dialog is blocking page scripts; respond with browser-devtools action=dialog before observing further.",
  "expect-timeout":
    "The expected condition was not met within the observation window. This is an observation timeout, not proof that the action failed; verify before repeating a side-effecting action.",
};

/** expect 在窗口内满足时的回执说明（避免与 unchanged 的否定措辞混淆）。 */
const EXPECT_SATISFIED_NOTE =
  "The expect condition was satisfied within the observation window; verify the business outcome before repeating a side-effecting action.";

const clampTimeout = (value: number): number =>
  Math.max(
    MIN_OBSERVE_TIMEOUT_MS,
    Math.min(MAX_OBSERVE_TIMEOUT_MS, Math.round(value)),
  );

const readExpect = (value: unknown): BrowserObservationExpect | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const read = (field: string): string | undefined => {
    const raw = record[field];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };
  const expect: BrowserObservationExpect = {
    urlIncludes: read("urlIncludes"),
    selector: read("selector"),
    text: read("text"),
  };
  return expect.urlIncludes || expect.selector || expect.text
    ? expect
    : undefined;
};

/**
 * 解析动作参数里的观察配置。observe 缺省为 brief（有界观察），
 * observe=none 保持原始低延迟路径（不装探针、不轮询）。
 */
export const parseObservationRequest = (
  args: Record<string, unknown>,
): BrowserObservationRequest | null => {
  const rawMode =
    typeof args.observe === "string" ? args.observe.trim().toLowerCase() : "";
  if (rawMode === "none") return null;
  const mode = rawMode === "snapshot" ? "snapshot" : "brief";
  const expect = readExpect(args.expect);
  const rawTimeout = args.observeTimeoutMs;
  const timeoutMs = clampTimeout(
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
      ? rawTimeout
      : expect
        ? DEFAULT_EXPECT_TIMEOUT_MS
        : DEFAULT_OBSERVE_TIMEOUT_MS,
  );
  return { mode, timeoutMs, ...(expect ? { expect } : {}) };
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const runPageScript = async <T>(
  webview: Electron.WebviewTag,
  script: string,
  timeoutMs: number,
): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      webview.executeJavaScript(script) as Promise<T>,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ])) as T | null;
  } catch {
    // 导航中 / 弹窗阻塞 / 页面已销毁：观察信号缺失，由调用方判定状态。
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** 在目标帧内评估 expect / 采样文本；帧失效或 CDP 不可用时返回 error，不伪造满足。 */
const readFrameObservation = async (
  webview: Electron.WebviewTag,
  frameId: string,
  expect: BrowserObservationExpect | undefined,
  sampleText: boolean,
  maxChars: number,
): Promise<FrameObservation> => {
  try {
    const result = (await window.snow.browserFrameOperation(
      webview.getWebContentsId(),
      "observe",
      {
        frameId,
        ...(expect ? { expect } : {}),
        ...(sampleText ? { sampleText: true, maxChars } : {}),
      },
    )) as Record<string, unknown> | null;
    const record = result !== null && typeof result === "object" ? result : {};
    return {
      ...(typeof record.url === "string" ? { url: record.url } : {}),
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.matches === "boolean"
        ? { matches: record.matches }
        : {}),
      ...(typeof record.text === "string" ? { text: record.text } : {}),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/** 读取当前聚焦控件的值（密码/隐藏/文件控件不读），用于识别「输入已生效」。 */
const ACTIVE_VALUE_READER = `const readActiveValue = () => {
  try {
    const element = document.activeElement;
    if (!element || typeof element.value !== 'string') return null;
    const type = String((element.getAttribute && element.getAttribute('type')) || '').toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'file') return null;
    return element.value.slice(0, 200);
  } catch (error) {
    return null;
  }
};`;

const INSTALL_PROBE_SCRIPT = `(() => {
  const KEY = ${JSON.stringify(PROBE_KEY)};
  ${ACTIVE_VALUE_READER}
  try {
    const previous = window[KEY];
    if (previous && previous.observer) previous.observer.disconnect();
  } catch (error) {}
  const probe = { mutations: 0, startedAt: Date.now() };
  window[KEY] = probe;
  try {
    probe.observer = new MutationObserver((records) => {
      probe.mutations += records.length;
    });
    probe.observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch (error) {}
  return readActiveValue();
})()`;

type ProbeSnapshot = {
  alive: boolean;
  url: string;
  title: string;
  readyState: string;
  mutations: number;
  activeValue: string | null;
  expect: Record<string, boolean>;
};

const buildProbeScript = (
  expect: BrowserObservationExpect | undefined,
): string => {
  const checks: string[] = [];
  if (expect?.urlIncludes) {
    checks.push(
      `checks.urlIncludes = String(location.href).includes(${JSON.stringify(expect.urlIncludes)});`,
    );
  }
  if (expect?.selector) {
    checks.push(
      `try { checks.selector = !!document.querySelector(${JSON.stringify(expect.selector)}); } catch (error) { checks.selector = false; }`,
    );
  }
  if (expect?.text) {
    checks.push(
      `checks.text = String(document.body ? document.body.innerText : '').includes(${JSON.stringify(expect.text)});`,
    );
  }
  return `(() => {
    const probe = window[${JSON.stringify(PROBE_KEY)}];
    ${ACTIVE_VALUE_READER}
    const checks = {};
    ${checks.join("\n    ")}
    return {
      alive: !!probe,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      mutations: probe ? probe.mutations : 0,
      activeValue: readActiveValue(),
      expect: checks,
    };
  })()`;
};

const buildStateScript = (wantText: boolean): string => `(() => {
  const result = { readyState: document.readyState, fields: [] };
  const hint = /search|query|keyword|filter|sort|order|搜索|筛选|查询|排序/i;
  const seen = new Set();
  const nodes = document.querySelectorAll('input, textarea, select, [role="searchbox"], [role="combobox"]');
  for (const element of Array.from(nodes).slice(0, 200)) {
    const type = String(element.getAttribute('type') || element.tagName || '').toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'file') continue;
    const label = [
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      element.getAttribute('name'),
      element.id,
      element.getAttribute('role'),
      type,
    ].filter(Boolean).join(' ');
    if (!hint.test(label)) continue;
    const value = String(element.value !== undefined ? element.value : element.textContent || '')
      .replace(/\\s+/g, ' ')
      .trim();
    if (!value) continue;
    const key = label + '=' + value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.fields.push({ field: label.slice(0, 80), value: value.slice(0, 120) });
    if (result.fields.length >= 6) break;
  }
  ${
    wantText
      ? `result.text = String(document.body ? document.body.innerText : '')
    .replace(/[ \\t]+\\n/g, '\\n')
    .trim()
    .slice(0, ${SNAPSHOT_TEXT_LENGTH});`
      : ""
  }
  return result;
})()`;

const UNINSTALL_PROBE_SCRIPT = `(() => {
  const KEY = ${JSON.stringify(PROBE_KEY)};
  try {
    const probe = window[KEY];
    if (probe && probe.observer) probe.observer.disconnect();
    delete window[KEY];
  } catch (error) {}
  return true;
})()`;

const readPendingDialogs = async (
  webview: Electron.WebviewTag,
): Promise<number> => {
  try {
    const dialogs = await window.snow.browserDialogs(
      webview.getWebContentsId(),
    );
    return Array.isArray(dialogs) ? dialogs.length : 0;
  } catch {
    return 0;
  }
};

/** 最新下载 id 作为本次动作的游标：之后新增的下载 id 一定更大。 */
const readDownloadCursor = async (): Promise<number> => {
  try {
    const items = await window.snow.listBrowserDownloads();
    return items.reduce(
      (max, item) =>
        typeof item.id === "number" ? Math.max(max, item.id) : max,
      0,
    );
  } catch {
    return 0;
  }
};

const countNewDownloads = async (cursor: number): Promise<number> => {
  try {
    const items = await window.snow.listBrowserDownloads();
    return items.filter(
      (item) => typeof item.id === "number" && item.id > cursor,
    ).length;
  } catch {
    return 0;
  }
};

/** 本次动作窗口内新增的错误级控制台消息（按 recordedAt 取增量，不清空日志）。 */
const collectConsoleErrors = (
  messages: readonly unknown[],
  sinceIso: string,
): { message: string; source?: string; line?: number }[] => {
  const errors: { message: string; source?: string; line?: number }[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      level?: unknown;
      message?: unknown;
      sourceId?: unknown;
      line?: unknown;
      recordedAt?: unknown;
    };
    if (typeof record.recordedAt !== "string" || record.recordedAt < sinceIso) {
      continue;
    }
    if (typeof record.level !== "number" || record.level < 3) continue;
    errors.push({
      message: String(record.message ?? "").slice(0, 200),
      ...(typeof record.sourceId === "string" && record.sourceId
        ? { source: String(record.sourceId).slice(0, 200) }
        : {}),
      ...(typeof record.line === "number" ? { line: record.line } : {}),
    });
    if (errors.length >= MAX_CONSOLE_ERRORS) break;
  }
  errors.reverse();
  return errors;
};

export type BrowserActionObservationHandle = {
  stop: () => Promise<BrowserActionObservation>;
  /** 动作失败时直接丢弃探针，不等待观察窗口。 */
  cancel: () => Promise<void>;
};

/**
 * 动作派发前调用：记录基线（URL/标题/弹窗/下载游标）并安装探针。
 * 探针安装失败不阻断动作，后续只依赖 URL/标题/loading 信号。
 */
export const startActionObservation = async (
  webview: Electron.WebviewTag,
  request: BrowserObservationRequest,
  getConsoleMessages: () => readonly unknown[],
  startedAt: number,
  frameId?: string,
): Promise<BrowserActionObservationHandle> => {
  const beforeUrl = webview.getURL();
  const beforeTitle = webview.getTitle();
  const sinceIso = new Date(startedAt).toISOString();
  const dialogsBefore = await readPendingDialogs(webview);
  const downloadCursor = await readDownloadCursor();
  // 帧作用域下 expect 由目标帧评估，顶层探针不再重复检查。
  const probeScript = buildProbeScript(frameId ? undefined : request.expect);
  // 期望条件的数量：探针返回值必须完整覆盖，避免空检查对象被误判为满足。
  const expectCount = request.expect
    ? [
        request.expect.urlIncludes,
        request.expect.selector,
        request.expect.text,
      ].filter(Boolean).length
    : 0;
  const activeValueBefore = await runPageScript<string | null>(
    webview,
    INSTALL_PROBE_SCRIPT,
    PROBE_INSTALL_TIMEOUT_MS,
  );

  const stop = async (): Promise<BrowserActionObservation> => {
    // 观察窗口从派发结束开始计时：慢动作（逐键输入、批量填表）不应吃掉观察预算。
    const windowStart = Date.now();
    const deadline = windowStart + request.timeoutMs;
    const changes: string[] = [];
    let probeUnresponsive = false;
    let expectEvaluated = !request.expect;
    let expectSatisfied = false;
    let probeMisses = 0;
    let frameObservation: FrameObservation = {};
    const addChange = (name: string): void => {
      if (!changes.includes(name)) changes.push(name);
    };

    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS);
      if (webview.getURL() !== beforeUrl) addChange("url");
      if (webview.getTitle() !== beforeTitle) addChange("title");

      const probe = await runPageScript<ProbeSnapshot>(
        webview,
        probeScript,
        PROBE_TIMEOUT_MS,
      );
      if (!probe) {
        probeMisses += 1;
        // 连续两次无响应：页面脚本被阻塞（多为 JS 弹窗）或正在导航。
        if (probeMisses >= 2) {
          probeUnresponsive = true;
          break;
        }
        continue;
      }
      probeMisses = 0;
      if (!probe.alive) {
        // 探针随旧文档销毁 = 发生了文档级导航；在新文档重新安装后继续观察。
        addChange("document");
        await runPageScript(
          webview,
          INSTALL_PROBE_SCRIPT,
          PROBE_INSTALL_TIMEOUT_MS,
        );
      } else if (probe.mutations > 0) {
        addChange("dom");
      }
      // 输入类动作：聚焦控件的值发生变化时不算 DOM 变化，单独标记。
      if (
        typeof activeValueBefore === "string" &&
        typeof probe.activeValue === "string" &&
        probe.activeValue !== activeValueBefore
      ) {
        addChange("value");
      }

      if (request.expect) {
        if (frameId) {
          // expect 在目标帧内评估；帧失效时保持「未评估」，最终按 expect-timeout 回报。
          const frame = await readFrameObservation(
            webview,
            frameId,
            request.expect,
            false,
            SNAPSHOT_TEXT_LENGTH,
          );
          frameObservation = frame;
          if (typeof frame.matches === "boolean") {
            expectEvaluated = true;
            expectSatisfied = frame.matches;
            if (expectSatisfied) break;
          }
        } else if (probe.alive) {
          // 探针随文档销毁时无法评估条件（空检查对象不能当作满足）。
          expectEvaluated = true;
          const checks = Object.values(probe.expect ?? {});
          expectSatisfied =
            checks.length === expectCount && checks.every(Boolean);
          if (expectSatisfied) break;
        }
        // 有显式 expect 时持续等待到窗口结束（变化本身不算完成条件）。
        continue;
      }
      if (changes.length > 0) {
        await delay(SETTLE_MS);
        break;
      }
    }

    const waitedMs = Math.max(0, Date.now() - windowStart);
    if (frameId) {
      const finalFrame = await readFrameObservation(
        webview,
        frameId,
        undefined,
        request.mode === "snapshot",
        SNAPSHOT_TEXT_LENGTH,
      );
      // 无 expect 的采样返回 matches=false；保留轮询期间已评估的满足状态。
      frameObservation = {
        ...frameObservation,
        ...finalFrame,
        ...(frameObservation.matches !== undefined
          ? { matches: frameObservation.matches }
          : {}),
      };
    }
    const dialogsPending = await readPendingDialogs(webview);
    const dialogsOpened = Math.max(0, dialogsPending - dialogsBefore);
    const downloadsStarted = await countNewDownloads(downloadCursor);
    const consoleErrors = collectConsoleErrors(getConsoleMessages(), sinceIso);
    const isLoading = webview.isLoading();
    const state = await runPageScript<{
      readyState: string;
      fields: { field: string; value: string }[];
      text?: string;
    }>(
      webview,
      buildStateScript(request.mode === "snapshot"),
      PROBE_TIMEOUT_MS,
    );

    const status: BrowserObservationStatus =
      dialogsPending > 0
        ? "blocked"
        : request.expect && !expectSatisfied
          ? "expect-timeout"
          : isLoading
            ? "navigating"
            : changes.length > 0
              ? "changed"
              : "unchanged";

    const noteBase =
      status === "blocked"
        ? STATUS_NOTES.blocked
        : request.expect && expectEvaluated && expectSatisfied
          ? EXPECT_SATISFIED_NOTE
          : STATUS_NOTES[status];
    const observation: BrowserActionObservation = {
      mode: request.mode,
      ...(frameId ? { scope: "frame" as const, frame: frameObservation } : {}),
      status,
      waitedMs,
      changes,
      ...(probeUnresponsive ? { probe: "unresponsive" as const } : {}),
      ...(request.expect
        ? {
            expect: {
              conditions: [
                ...(request.expect.urlIncludes
                  ? [`urlIncludes:${request.expect.urlIncludes}`]
                  : []),
                ...(request.expect.selector
                  ? [`selector:${request.expect.selector}`]
                  : []),
                ...(request.expect.text ? [`text:${request.expect.text}`] : []),
              ],
              satisfied: expectEvaluated && expectSatisfied,
            },
          }
        : {}),
      ...(dialogsPending > 0 ||
      dialogsOpened > 0 ||
      downloadsStarted > 0 ||
      consoleErrors.length > 0
        ? {
            events: {
              dialogsPending,
              dialogsOpened,
              downloadsStarted,
              consoleErrors,
            },
          }
        : {}),
      ...(state
        ? {
            state: {
              readyState: state.readyState,
              ...(Array.isArray(state.fields) && state.fields.length > 0
                ? { searchFields: state.fields }
                : {}),
            },
          }
        : {}),
      ...(request.mode === "snapshot"
        ? frameId
          ? typeof frameObservation.text === "string"
            ? { text: frameObservation.text }
            : {}
          : typeof state?.text === "string"
            ? { text: state.text }
            : {}
        : {}),
      note: frameId
        ? `${noteBase} Frame scope: expect is evaluated in the target frame; URL/title/loading/events are observed at the top level.`
        : noteBase,
    };
    // 观察结束即清理探针，避免长期占用页面观察器（不等待，页面可能已导航）。
    void runPageScript(
      webview,
      UNINSTALL_PROBE_SCRIPT,
      PROBE_INSTALL_TIMEOUT_MS,
    );
    return observation;
  };

  return {
    stop,
    cancel: async (): Promise<void> => {
      await runPageScript(
        webview,
        UNINSTALL_PROBE_SCRIPT,
        PROBE_INSTALL_TIMEOUT_MS,
      );
    },
  };
};
