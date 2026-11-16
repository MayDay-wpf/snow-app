import { app, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";
import {
  getBrowserWebContents,
  registerDebuggerMessageListener,
} from "./browserNetworkRecorder";
import {
  enabledScriptSessions,
  ensureScriptDebugger,
  findScriptById,
  lookupScriptLocation,
  onScriptDebuggerReset,
  onScriptParsed,
  onScriptSessionEnabled,
  scriptAutoResumed,
  scriptCdp,
  setScriptDebuggerHold,
  type ScriptTarget,
} from "./browserScripts";

/**
 * 日志断点（logpoint）：用 CDP Debugger.setBreakpointByUrl 注入条件表达式，
 * 命中时在页面内格式化变量并经 Runtime 绑定回传，条件恒返回 false，页面不暂停。
 * url 可以是浏览器加载的脚本，也可以是 source map 里的原始源码路径。
 */

const SENTINEL = "[snow-logpoint]";
const DEFAULT_MAX_HITS = 20;
const MAX_HITS_PER_LOGPOINT = 50;
const MAX_HIT_RECORDS = 200;
const MAX_EXPRESSION_COUNT = 20;
const MAX_LOCATIONS = 5;
const RERESOLVE_DEBOUNCE_MS = 400;
const HOLD_NAME = "logpoints";

/** 控制台兜底通道的哨兵消息不进入控制台记录。 */
export const isBrowserLogpointMessage = (args: unknown): boolean => {
  if (!Array.isArray(args) || args.length === 0) return false;
  const first = args[0] as { type?: unknown; value?: unknown } | undefined;
  return first?.type === "string" && typeof first.value === "string"
    ? first.value.startsWith(SENTINEL)
    : false;
};

export type BrowserLogpointSpec = {
  /** 稳定标识；未提供时由主进程生成，重复提交同 id 即更新该断点。 */
  id?: string;
  /** 脚本 URL 子串、原始源码路径（source map），或正则（urlRegex / `/正则/`）。 */
  url: string;
  urlRegex?: boolean;
  /** 1 起行号。 */
  lineNumber: number;
  /** 1 起列号。 */
  columnNumber?: number;
  condition?: string;
  expressions?: string[];
  label?: string;
  maxHits?: number;
};

export type BrowserLogpointHit = {
  logpointId: string;
  label?: string;
  url: string;
  lineNumber: number;
  hit: number;
  /** 表达式原文 -> 格式化后的值。 */
  vars: Record<string, string>;
  frame?: boolean;
  at: string;
};

export type BrowserLogpointLocation = {
  url: string;
  lineNumber: number;
  columnNumber: number;
  frame?: boolean;
};

export type BrowserLogpointState = {
  id: string;
  url: string;
  urlRegex: boolean;
  lineNumber: number;
  columnNumber?: number;
  condition?: string;
  expressions: string[];
  label?: string;
  maxHits: number;
  hits: number;
  exhausted: boolean;
  /** 该断点在各 CDP 会话里下发的断点数。 */
  breakpoints: number;
  /** 是否已绑定到实际脚本位置。 */
  bound: boolean;
  /** 实际绑定位置（1 起行列）。 */
  locations: BrowserLogpointLocation[];
  /** 经 source map 定位时的原始源码位置（1 起行列）。 */
  source?: { url: string; lineNumber: number; columnNumber: number };
  warning?: string;
  candidates?: string[];
  /** 最近一次条件或表达式求值错误。 */
  lastError?: string;
  errorCount?: number;
};

type Resolution = {
  mode: "generated" | "original";
  matched: boolean;
  targets: ScriptTarget[];
  source?: { url: string; lineNumber: number; columnNumber: number };
  warning?: string;
  candidates?: string[];
};

type Spec = {
  id: string;
  url: string;
  urlRegex: boolean;
  lineNumber: number;
  columnNumber?: number;
  condition?: string;
  expressions: string[];
  label?: string;
  maxHits: number;
  /** 断点内容或落点变化时递增，驱动各会话重新下发。 */
  rev: number;
  /** 页面内计数与回传消息的代际标记。 */
  nonce: string;
  resolution: Resolution;
  /** 最近一次实际绑定的位置，断点退役后仍用于展示。 */
  lastLocations: BrowserLogpointLocation[];
};

type AppliedBreakpoint = {
  breakpointId: string;
  locations: { scriptId: string; lineNumber: number; columnNumber: number }[];
};

type AppliedSpec = {
  rev: number;
  breakpoints: AppliedBreakpoint[];
  error?: string;
};

type TabState = {
  specs: Map<string, Spec>;
  hits: BrowserLogpointHit[];
  hitsBySpec: Map<string, number>;
  errors: Map<string, { count: number; last: string }>;
  /** sessionKey -> specId -> 已下发的断点。 */
  applied: Map<string, Map<string, AppliedSpec>>;
  bindingSessions: Set<string>;
  sessionChains: Map<string, Promise<unknown>>;
  queue: Promise<unknown>;
  token: string;
  reresolveTimer?: ReturnType<typeof setTimeout>;
};

const states = new Map<number, TabState>();

const tabState = (webContentsId: number): TabState => {
  let state = states.get(webContentsId);
  if (!state) {
    state = {
      specs: new Map(),
      hits: [],
      hitsBySpec: new Map(),
      errors: new Map(),
      applied: new Map(),
      bindingSessions: new Set(),
      sessionChains: new Map(),
      queue: Promise.resolve(),
      token: randomUUID().replace(/-/g, "").slice(0, 12),
    };
    states.set(webContentsId, state);
  }
  return state;
};

const bindingName = (state: TabState): string => `__snowLp_${state.token}`;
const counterName = (state: TabState): string => `__snowLpC_${state.token}`;
const newNonce = (): string => randomUUID().slice(0, 8);
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 串行化同一标签页的断点增删，避免并发重建留下孤儿断点。 */
const runQueued = <T>(state: TabState, task: () => Promise<T>): Promise<T> => {
  const next = state.queue.then(task, task);
  state.queue = next.catch(() => undefined);
  return next;
};

/** 同一 CDP 会话的断点下发按序执行（新 iframe 的初始化不必等全局队列）。 */
const runForSession = <T>(
  state: TabState,
  sessionKey: string,
  task: () => Promise<T>,
): Promise<T> => {
  const previous = state.sessionChains.get(sessionKey) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => undefined);
  state.sessionChains.set(sessionKey, settled);
  void settled.then(() => {
    if (state.sessionChains.get(sessionKey) === settled) {
      state.sessionChains.delete(sessionKey);
    }
  });
  return next;
};

/**
 * 页面内执行的采集函数（m=元数据，x=表达式 thunk，c=条件 thunk）。
 * 表达式以箭头函数在断点作用域内创建，既能读局部变量，又能逐个捕获异常；
 * 本函数自己的局部变量不会遮蔽页面变量。计数存在页面里，热路径上超限后立即返回。
 */
const PAGE_HELPER = String.raw`(function(m,x,c){try{
var g=globalThis,t=g[m.k];
if(!t){t={};try{Object.defineProperty(g,m.k,{value:t,enumerable:false,configurable:true})}catch(e){}}
var k=m.i+":"+m.r,n=t[k]|0;
if(n>=m.m)return false;
var J=JSON.stringify,T=Object.prototype.toString,S=[],B=0;
var send=function(o){var s=J(o),f=g[m.b];if(typeof f==="function"){f(s)}else{console.log(m.s+s)}};
var text=function(e){try{return String(e&&e.message!==undefined?(e.name||"Error")+": "+e.message:e).slice(0,400)}catch(_){return"error"}};
if(c){var ok;try{ok=c()}catch(e){var q=t["e:"+k]|0;if(q<3){t["e:"+k]=q+1;send({i:m.i,r:m.r,w:"condition",e:text(e)})}return false}if(!ok)return false}
t[k]=n+1;
var F=function(v,d){
if(v===null)return"null";
var y=typeof v;
if(y==="undefined")return"undefined";
if(y==="string"){var L=d?300:3000;return J(v.length>L?v.slice(0,L)+"...("+v.length+" chars)":v)}
if(y==="number"||y==="boolean")return String(v);
if(y==="bigint")return String(v)+"n";
if(y==="symbol")return String(v);
if(y==="function")return"[Function "+(v.name||"anonymous")+"]";
if(B<=0)return"...";
if(S.indexOf(v)>=0)return"[Circular]";
var tag=T.call(v);
if(tag==="[object Error]"||v instanceof Error)return"["+text(v)+"]";
if(tag==="[object Date]")return isNaN(v)?"Invalid Date":v.toISOString();
if(tag==="[object RegExp]")return String(v);
if(typeof Node!=="undefined"&&v instanceof Node)return"<"+String(v.nodeName||"node").toLowerCase()+(v.id?"#"+v.id:"")+">";
if(v===g||tag==="[object Window]")return"[Window]";
if(tag==="[object Promise]")return"[Promise]";
var cn="";try{cn=(v.constructor&&v.constructor.name)||""}catch(e){}
var isA=Array.isArray(v);
if(d>=3)return isA?"[Array("+v.length+")]":"["+(cn||"Object")+"]";
S.push(v);
try{
var p=[],i=0,r;
if(isA){
for(;i<v.length&&i<50;i++){r=F(v[i],d+1);B-=r.length+2;p.push(r);if(B<=0)break}
if(v.length>p.length)p.push("..."+(v.length-p.length)+" more");
return"["+p.join(", ")+"]"}
if(tag==="[object Map]"||tag==="[object Set]"){
var isM=tag==="[object Map]";
v.forEach(function(a,b){if(i<30&&B>0){r=isM?F(b,d+1)+" => "+F(a,d+1):F(a,d+1);B-=r.length+2;p.push(r)}i++});
if(i>p.length)p.push("..."+(i-p.length)+" more");
return(isM?"Map(":"Set(")+v.size+") {"+p.join(", ")+"}"}
if(tag==="[object ArrayBuffer]"||ArrayBuffer.isView(v))return(cn||"ArrayBuffer")+"("+(v.length!==undefined?v.length:v.byteLength)+")";
var ks=Object.keys(v);
for(;i<ks.length&&i<50;i++){
try{r=F(v[ks[i]],d+1)}catch(e){r="[Thrown: "+text(e)+"]"}
r=(/^[A-Za-z_$][\w$]*$/.test(ks[i])?ks[i]:J(ks[i]))+": "+r;B-=r.length+2;p.push(r);if(B<=0)break}
if(ks.length>p.length)p.push("..."+(ks.length-p.length)+" more");
return(cn&&cn!=="Object"?cn+" ":"")+"{"+p.join(", ")+"}"
}finally{S.pop()}};
var out=[];
for(var j=0;j<x.length;j++){var z;B=6000;S.length=0;
try{z=F(x[j](),0)}catch(e){z="[Thrown: "+text(e)+"]"}
if(z.length>8000)z=z.slice(0,8000)+"...("+z.length+" chars)";out.push(z)}
send({i:m.i,r:m.r,n:n+1,v:out});
}catch(e){}return false})`;

/** 表达式末尾补换行，避免行注释吞掉右括号。 */
const thunk = (expression: string): string => `()=>(${expression}\n)`;

const buildCondition = (state: TabState, spec: Spec): string => {
  const meta = JSON.stringify({
    i: spec.id,
    r: spec.nonce,
    m: spec.maxHits,
    b: bindingName(state),
    k: counterName(state),
    s: SENTINEL,
  });
  const thunks = spec.expressions.map(thunk).join(",");
  const guard = spec.condition ? thunk(spec.condition) : "null";
  return `${PAGE_HELPER}(${meta},[${thunks}],${guard})`;
};

/** 只编译不执行，把语法错误提前到设置阶段报告。 */
const assertSyntax = (code: string, what: string): void => {
  try {
    new Script(code);
  } catch (error) {
    throw new Error(`${what} has a syntax error: ${describe(error)}`);
  }
};

/** 把子串转成字面量正则：CDP 的 url 是精确匹配，urlRegex 才是包含匹配。 */
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `/正则/` 字面量：返回内部表达式，否则 undefined。 */
const slashBody = (value: string): string | undefined => {
  const matched = /^\/([\s\S]+)\/$/.exec(value);
  return matched ? matched[1] : undefined;
};

const toCdpUrlRegex = (spec: Spec): string => {
  if (!spec.urlRegex) return escapeRegExp(spec.url);
  return slashBody(spec.url) ?? spec.url;
};

const fingerprint = (resolution: Resolution): string =>
  JSON.stringify([resolution.mode, resolution.targets]);

/** 确定断点落点：原始源码（source map）优先，其次按子串匹配生成脚本。 */
const resolveLocation = async (
  contents: WebContents,
  spec: Pick<Spec, "url" | "urlRegex" | "lineNumber" | "columnNumber">,
  hints: string[],
): Promise<Resolution> => {
  if (spec.urlRegex) return { mode: "generated", matched: true, targets: [] };
  const lookup = await lookupScriptLocation(
    contents,
    {
      url: spec.url,
      lineNumber: spec.lineNumber - 1,
      ...(spec.columnNumber !== undefined
        ? { columnNumber: spec.columnNumber - 1 }
        : {}),
    },
    hints,
  );
  if (lookup.kind === "ambiguous") {
    throw new Error(
      `"${spec.url}" matches multiple sources: ${lookup.sources.slice(0, 5).join(", ")}. Specify a longer path.`,
    );
  }
  if (lookup.kind === "original") {
    if (lookup.targets.length === 0) {
      throw new Error(
        `No executable code at or after line ${spec.lineNumber} of ${lookup.source} (comment, type annotation, or code removed from the bundle). Pick a line containing executable code.`,
      );
    }
    const line = lookup.lineNumber + 1;
    return {
      mode: "original",
      matched: true,
      targets: lookup.targets,
      source: {
        url: lookup.source,
        lineNumber: line,
        columnNumber: lookup.columnNumber + 1,
      },
      ...(line !== spec.lineNumber
        ? {
            warning: `Line ${spec.lineNumber} has no executable code; the logpoint moved to line ${line}.`,
          }
        : {}),
    };
  }
  if (lookup.kind === "generated") {
    const longest = Math.max(...lookup.scripts.map((item) => item.endLine + 1));
    return {
      mode: "generated",
      matched: true,
      targets: [],
      ...(spec.lineNumber > longest
        ? {
            warning: `Line ${spec.lineNumber} is past the end of the matched script (${longest} lines). Minified bundles are usually a single line: use action=scriptSearch to get the lineNumber and columnNumber.`,
          }
        : {}),
    };
  }
  return {
    mode: "generated",
    matched: false,
    targets: [],
    warning: `No loaded script or original source matches "${spec.url}" yet; the logpoint binds automatically when a matching script loads.${lookup.mapsTimedOut ? " Some source maps were still loading; retry if the file comes from a source map." : ""}`,
    ...(lookup.candidates.length > 0 ? { candidates: lookup.candidates } : {}),
  };
};

/** 命中已达上限的断点不再下发。 */
const activeSpecs = (state: TabState): Spec[] =>
  [...state.specs.values()].filter(
    (spec) => (state.hitsBySpec.get(spec.id) ?? 0) < spec.maxHits,
  );

const breakpointRequests = (spec: Spec): Record<string, unknown>[] =>
  spec.resolution.mode === "original"
    ? spec.resolution.targets.map((target) => ({
        url: target.url,
        lineNumber: target.lineNumber,
        columnNumber: target.columnNumber,
      }))
    : [
        {
          urlRegex: toCdpUrlRegex(spec),
          lineNumber: spec.lineNumber - 1,
          ...(spec.columnNumber !== undefined
            ? { columnNumber: spec.columnNumber - 1 }
            : {}),
        },
      ];

const parseLocation = (
  raw: unknown,
): AppliedBreakpoint["locations"][number] | undefined => {
  const location = (raw ?? {}) as Record<string, unknown>;
  if (
    typeof location.scriptId !== "string" ||
    typeof location.lineNumber !== "number"
  )
    return undefined;
  return {
    scriptId: location.scriptId,
    lineNumber: location.lineNumber,
    columnNumber:
      typeof location.columnNumber === "number" ? location.columnNumber : 0,
  };
};

const removeApplied = async (
  contents: WebContents,
  sessionKey: string,
  applied: AppliedSpec,
): Promise<void> => {
  for (const { breakpointId } of applied.breakpoints) {
    try {
      await scriptCdp(
        contents,
        "Debugger.removeBreakpoint",
        { breakpointId },
        sessionKey,
      );
    } catch {
      // 会话已失效时无需清理。
    }
  }
};

/** 让一个会话里的断点与当前规则一致：撤掉过期的，补上缺失的。 */
const reconcileSession = (
  contents: WebContents,
  state: TabState,
  sessionKey: string,
): Promise<void> =>
  runForSession(state, sessionKey, async () => {
    if (!state.bindingSessions.has(sessionKey)) {
      try {
        await scriptCdp(
          contents,
          "Runtime.addBinding",
          { name: bindingName(state) },
          sessionKey,
        );
      } catch {
        // 绑定不可用时页面侧回退到 console 通道。
      }
      state.bindingSessions.add(sessionKey);
    }
    let applied = state.applied.get(sessionKey);
    if (!applied) {
      applied = new Map();
      state.applied.set(sessionKey, applied);
    }
    const wanted = new Map(activeSpecs(state).map((spec) => [spec.id, spec]));
    for (const [id, entry] of [...applied]) {
      if (wanted.get(id)?.rev === entry.rev) continue;
      applied.delete(id);
      await removeApplied(contents, sessionKey, entry);
    }
    for (const spec of wanted.values()) {
      if (applied.has(spec.id)) continue;
      const entry: AppliedSpec = { rev: spec.rev, breakpoints: [] };
      applied.set(spec.id, entry);
      const condition = buildCondition(state, spec);
      for (const request of breakpointRequests(spec)) {
        try {
          const result = (await scriptCdp(
            contents,
            "Debugger.setBreakpointByUrl",
            { ...request, condition },
            sessionKey,
          )) as { breakpointId?: unknown; locations?: unknown } | undefined;
          if (typeof result?.breakpointId !== "string") continue;
          entry.breakpoints.push({
            breakpointId: result.breakpointId,
            locations: (Array.isArray(result.locations) ? result.locations : [])
              .map(parseLocation)
              .filter(
                (item): item is AppliedBreakpoint["locations"][number] =>
                  item !== undefined,
              ),
          });
        } catch (error) {
          entry.error = describe(error);
        }
      }
    }
  });

const reconcileAll = async (
  contents: WebContents,
  state: TabState,
): Promise<void> => {
  const sessions = enabledScriptSessions(contents.id);
  for (const key of [...state.applied.keys()]) {
    if (sessions.includes(key)) continue;
    state.applied.delete(key);
    state.bindingSessions.delete(key);
  }
  for (const sessionKey of sessions) {
    try {
      await reconcileSession(contents, state, sessionKey);
    } catch {
      // 会话可能已消失。
    }
  }
};

/** 重新接上调试器并恢复全部断点（DevTools 关闭、调试器重连之后）。 */
const restore = async (
  webContentsId: number,
  state: TabState,
): Promise<void> => {
  const contents = getBrowserWebContents(webContentsId);
  await ensureScriptDebugger(contents);
  await reconcileAll(contents, state);
};

/** 新脚本出现后重新定位：待绑定的断点尝试升级，source map 断点跟随重新构建的产物。 */
const reresolve = async (
  webContentsId: number,
  state: TabState,
): Promise<void> => {
  let contents: WebContents;
  try {
    contents = getBrowserWebContents(webContentsId);
  } catch {
    return;
  }
  if (!contents.debugger.isAttached()) return;
  let changed = false;
  for (const spec of state.specs.values()) {
    if (!needsReresolve(spec)) continue;
    let next: Resolution;
    try {
      next = await resolveLocation(
        contents,
        spec,
        spec.resolution.targets.map((target) => target.url),
      );
    } catch (error) {
      spec.resolution = { ...spec.resolution, warning: describe(error) };
      continue;
    }
    // 页面重载途中脚本尚未到齐时保留原有落点，不降级。
    if (spec.resolution.mode === "original" && next.mode !== "original")
      continue;
    if (fingerprint(next) !== fingerprint(spec.resolution)) {
      spec.rev += 1;
      changed = true;
    }
    spec.resolution = next;
  }
  if (changed) await reconcileAll(contents, state);
};

const needsReresolve = (spec: Spec): boolean =>
  !spec.urlRegex &&
  (spec.resolution.mode === "original" || !spec.resolution.matched);

const recordError = (state: TabState, id: string, message: string): void => {
  const previous = state.errors.get(id);
  state.errors.set(id, { count: (previous?.count ?? 0) + 1, last: message });
};

const handlePayload = (
  webContentsId: number,
  state: TabState,
  text: string,
  sessionKey: string,
): void => {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!payload || typeof payload.i !== "string") return;
  const spec = state.specs.get(payload.i);
  if (!spec || payload.r !== spec.nonce) return;
  if (typeof payload.e === "string") {
    recordError(
      state,
      spec.id,
      `${typeof payload.w === "string" ? payload.w : "expression"}: ${payload.e}`,
    );
    return;
  }
  const hit = (state.hitsBySpec.get(spec.id) ?? 0) + 1;
  if (hit > spec.maxHits) return;
  const values = Array.isArray(payload.v) ? payload.v : [];
  const vars: Record<string, string> = {};
  spec.expressions.forEach((expression, index) => {
    const raw = values[index];
    const value = typeof raw === "string" ? raw : "undefined";
    let key =
      expression.length > 80 ? `${expression.slice(0, 77)}...` : expression;
    if (key in vars) key = `${key} #${index + 1}`;
    vars[key] = value;
    if (value.startsWith("[Thrown: ")) {
      recordError(state, spec.id, `${key}: ${value.slice(9, -1)}`);
    }
  });
  state.hits.push({
    logpointId: spec.id,
    ...(spec.label ? { label: spec.label } : {}),
    url: spec.resolution.source?.url ?? spec.url,
    lineNumber: spec.resolution.source?.lineNumber ?? spec.lineNumber,
    hit,
    vars,
    ...(sessionKey ? { frame: true } : {}),
    at: new Date().toISOString(),
  });
  if (state.hits.length > MAX_HIT_RECORDS) {
    state.hits.splice(0, state.hits.length - MAX_HIT_RECORDS);
  }
  state.hitsBySpec.set(spec.id, hit);
  if (hit >= spec.maxHits) {
    // 达到上限后把断点从 CDP 撤掉。
    void runQueued(state, async () => {
      await reconcileAll(getBrowserWebContents(webContentsId), state);
    }).catch(() => undefined);
  }
};

/** 导航后撤掉某会话的旧断点并按当前规则重新下发。 */
const resetSessionBreakpoints = (
  webContentsId: number,
  state: TabState,
  sessionKey: string,
): void => {
  if (!state.applied.has(sessionKey) || state.specs.size === 0) {
    state.applied.delete(sessionKey);
    return;
  }
  void runQueued(state, async () => {
    const contents = getBrowserWebContents(webContentsId);
    if (!contents.debugger.isAttached()) return;
    const previous = state.applied.get(sessionKey);
    state.applied.delete(sessionKey);
    for (const entry of previous?.values() ?? []) {
      await removeApplied(contents, sessionKey, entry);
    }
    await reconcileSession(contents, state, sessionKey);
  }).catch(() => undefined);
};

const handleMessage = (
  webContentsId: number,
  method: string,
  params: unknown,
  sessionId: string,
): void => {
  const state = states.get(webContentsId);
  if (!state) return;
  const sessionKey = sessionId || "";
  if (method === "Runtime.executionContextsCleared") {
    // 导航后旧文档的断点可能残留，撤掉后按新文档重新下发。
    resetSessionBreakpoints(webContentsId, state, sessionKey);
    return;
  }
  if (method === "Runtime.bindingCalled") {
    const p = (params ?? {}) as { name?: unknown; payload?: unknown };
    if (p.name !== bindingName(state) || typeof p.payload !== "string") return;
    handlePayload(webContentsId, state, p.payload, sessionKey);
    return;
  }
  if (method === "Runtime.consoleAPICalled") {
    const p = (params ?? {}) as { type?: unknown; args?: unknown };
    if (p.type !== "log" || !isBrowserLogpointMessage(p.args)) return;
    const first = (p.args as { value: string }[])[0];
    handlePayload(
      webContentsId,
      state,
      first.value.slice(SENTINEL.length),
      sessionKey,
    );
    return;
  }
  if (method === "Debugger.breakpointResolved") {
    const p = (params ?? {}) as { breakpointId?: unknown; location?: unknown };
    const location = parseLocation(p.location);
    if (typeof p.breakpointId !== "string" || !location) return;
    for (const entry of state.applied.get(sessionKey)?.values() ?? []) {
      const breakpoint = entry.breakpoints.find(
        (item) => item.breakpointId === p.breakpointId,
      );
      if (!breakpoint) continue;
      if (breakpoint.locations.length < 20) breakpoint.locations.push(location);
      return;
    }
  }
};

export const initBrowserLogpoints = (): void => {
  registerDebuggerMessageListener(handleMessage);
  onScriptSessionEnabled(async (contents, sessionKey) => {
    const state = states.get(contents.id);
    if (!state || state.specs.size === 0) return;
    await reconcileSession(contents, state, sessionKey);
  });
  onScriptDebuggerReset((webContentsId) => {
    const state = states.get(webContentsId);
    if (!state) return;
    state.applied.clear();
    state.bindingSessions.clear();
  });
  onScriptParsed((webContentsId) => {
    const state = states.get(webContentsId);
    if (!state || ![...state.specs.values()].some(needsReresolve)) return;
    if (state.reresolveTimer) clearTimeout(state.reresolveTimer);
    state.reresolveTimer = setTimeout(() => {
      state.reresolveTimer = undefined;
      void runQueued(state, () => reresolve(webContentsId, state)).catch(
        () => undefined,
      );
    }, RERESOLVE_DEBOUNCE_MS);
  });
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    const id = contents.id;
    // DevTools 占用调试器期间断点失效，关闭后自动恢复。
    contents.on("devtools-closed", () => {
      const state = states.get(id);
      if (!state || state.specs.size === 0) return;
      void runQueued(state, () => restore(id, state)).catch(() => undefined);
    });
    contents.once("destroyed", () => {
      const state = states.get(id);
      if (state?.reresolveTimer) clearTimeout(state.reresolveTimer);
      states.delete(id);
    });
  });
};

export type BrowserLogpointApplyResult = {
  logpoint: BrowserLogpointState;
  active: number;
};

const toState = (
  webContentsId: number,
  state: TabState,
  spec: Spec,
): BrowserLogpointState => {
  const hits = state.hitsBySpec.get(spec.id) ?? 0;
  const exhausted = hits >= spec.maxHits;
  const locations: BrowserLogpointLocation[] = [];
  let breakpoints = 0;
  let applyError: string | undefined;
  for (const [sessionKey, applied] of state.applied) {
    const entry = applied.get(spec.id);
    if (!entry) continue;
    breakpoints += entry.breakpoints.length;
    applyError ??= entry.error;
    for (const breakpoint of entry.breakpoints) {
      for (const location of breakpoint.locations) {
        const item: BrowserLogpointLocation = {
          url:
            findScriptById(webContentsId, sessionKey, location.scriptId)?.url ??
            "",
          lineNumber: location.lineNumber + 1,
          columnNumber: location.columnNumber + 1,
          ...(sessionKey ? { frame: true } : {}),
        };
        if (
          !locations.some(
            (known) =>
              known.url === item.url &&
              known.lineNumber === item.lineNumber &&
              known.columnNumber === item.columnNumber,
          )
        )
          locations.push(item);
      }
    }
  }
  const boundNow = locations.length > 0;
  if (boundNow) spec.lastLocations = locations;
  // 命中上限后断点已从 CDP 撤下，沿用最后一次的绑定位置。
  const shown = boundNow ? locations : exhausted ? spec.lastLocations : [];
  const bound = shown.length > 0;
  const error = state.errors.get(spec.id);
  const moved =
    spec.resolution.mode === "generated" &&
    spec.columnNumber === undefined &&
    shown.length > 0 &&
    !shown.some((item) => item.lineNumber === spec.lineNumber)
      ? `Line ${spec.lineNumber} has no executable code; the logpoint moved to line ${shown[0].lineNumber}.`
      : undefined;
  const warning =
    spec.resolution.warning ??
    moved ??
    applyError ??
    (!bound && !exhausted && spec.resolution.matched
      ? "No breakable location is bound for this logpoint yet; check the line/column (action=scriptSearch returns exact positions) or wait for the script to load."
      : undefined);
  return {
    id: spec.id,
    url: spec.url,
    urlRegex: spec.urlRegex,
    lineNumber: spec.lineNumber,
    ...(spec.columnNumber !== undefined
      ? { columnNumber: spec.columnNumber }
      : {}),
    ...(spec.condition ? { condition: spec.condition } : {}),
    expressions: spec.expressions,
    ...(spec.label ? { label: spec.label } : {}),
    maxHits: spec.maxHits,
    hits,
    exhausted,
    breakpoints,
    bound,
    locations: shown.slice(0, MAX_LOCATIONS),
    ...(spec.resolution.source ? { source: spec.resolution.source } : {}),
    ...(warning ? { warning } : {}),
    ...(spec.resolution.candidates
      ? { candidates: spec.resolution.candidates }
      : {}),
    ...(error ? { lastError: error.last, errorCount: error.count } : {}),
  };
};

export const setBrowserLogpoint = async (
  webContentsId: number,
  raw: BrowserLogpointSpec,
): Promise<BrowserLogpointApplyResult> => {
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) {
    throw new Error(
      "url is required for a logpoint (script URL or source path)",
    );
  }
  if (!Number.isFinite(raw.lineNumber) || raw.lineNumber < 1) {
    throw new Error("lineNumber must be an integer >= 1 for a logpoint");
  }
  if (
    raw.columnNumber !== undefined &&
    (!Number.isFinite(raw.columnNumber) || raw.columnNumber < 1)
  ) {
    throw new Error("columnNumber must be an integer >= 1 for a logpoint");
  }
  const expressions = (raw.expressions ?? [])
    .filter((item) => typeof item === "string" && item.trim() !== "")
    .slice(0, MAX_EXPRESSION_COUNT);
  const condition = raw.condition?.trim() || undefined;
  for (const expression of expressions) {
    assertSyntax(thunk(expression), `Expression "${expression}"`);
  }
  if (condition) assertSyntax(thunk(condition), "condition");
  const contents = getBrowserWebContents(webContentsId);
  const state = tabState(webContentsId);
  return runQueued(state, async () => {
    setScriptDebuggerHold(webContentsId, HOLD_NAME, true);
    try {
      await ensureScriptDebugger(contents);
      const id = raw.id?.trim() || `lp-${randomUUID().slice(0, 8)}`;
      const previous = state.specs.get(id);
      const base = {
        id,
        url,
        urlRegex: raw.urlRegex === true || slashBody(url) !== undefined,
        lineNumber: Math.floor(raw.lineNumber),
        ...(raw.columnNumber !== undefined
          ? { columnNumber: Math.floor(raw.columnNumber) }
          : {}),
        ...(condition ? { condition } : {}),
        expressions,
        ...(raw.label?.trim() ? { label: raw.label.trim() } : {}),
        maxHits: Math.min(
          MAX_HITS_PER_LOGPOINT,
          Math.max(1, Math.floor(raw.maxHits ?? DEFAULT_MAX_HITS)),
        ),
      };
      const resolution = await resolveLocation(contents, base, []);
      const spec: Spec = {
        ...base,
        rev: (previous?.rev ?? 0) + 1,
        nonce: newNonce(),
        resolution,
        lastLocations: previous?.lastLocations ?? [],
      };
      assertSyntax(buildCondition(state, spec), "The logpoint");
      state.specs.set(id, spec);
      state.hitsBySpec.delete(id);
      state.errors.delete(id);
      await reconcileAll(contents, state);
      return {
        logpoint: toState(webContentsId, state, spec),
        active: state.specs.size,
      };
    } finally {
      if (state.specs.size === 0) {
        setScriptDebuggerHold(webContentsId, HOLD_NAME, false);
      }
    }
  });
};

export const removeBrowserLogpoint = async (
  webContentsId: number,
  logpointId: string,
): Promise<{ removed: boolean; active: number }> => {
  const state = states.get(webContentsId);
  if (!state || !state.specs.has(logpointId)) {
    return { removed: false, active: state?.specs.size ?? 0 };
  }
  return runQueued(state, async () => {
    const removed = state.specs.delete(logpointId);
    state.hitsBySpec.delete(logpointId);
    state.errors.delete(logpointId);
    const contents = getBrowserWebContents(webContentsId);
    if (contents.debugger.isAttached()) await reconcileAll(contents, state);
    if (state.specs.size === 0) {
      setScriptDebuggerHold(webContentsId, HOLD_NAME, false);
    }
    return { removed, active: state.specs.size };
  });
};

export const clearBrowserLogpoints = async (
  webContentsId: number,
): Promise<{ cleared: number }> => {
  const state = states.get(webContentsId);
  if (!state) return { cleared: 0 };
  return runQueued(state, async () => {
    const cleared = state.specs.size;
    state.specs.clear();
    state.hits = [];
    state.hitsBySpec.clear();
    state.errors.clear();
    const contents = getBrowserWebContents(webContentsId);
    if (contents.debugger.isAttached()) await reconcileAll(contents, state);
    setScriptDebuggerHold(webContentsId, HOLD_NAME, false);
    return { cleared };
  });
};

/** 断点存在但调试器已断开时尝试恢复；失败返回原因（如 DevTools 正开着）。 */
const ensureActive = async (
  webContentsId: number,
  state: TabState,
): Promise<string | undefined> => {
  if (state.specs.size === 0) return undefined;
  if (enabledScriptSessions(webContentsId).length > 0) return undefined;
  try {
    await runQueued(state, () => restore(webContentsId, state));
    return undefined;
  } catch (error) {
    return describe(error);
  }
};

export const listBrowserLogpoints = async (
  webContentsId: number,
): Promise<{
  logpoints: BrowserLogpointState[];
  autoResumed: number;
  suspended?: string;
}> => {
  const state = states.get(webContentsId);
  const autoResumed = scriptAutoResumed(webContentsId);
  if (!state) return { logpoints: [], autoResumed };
  const suspended = await ensureActive(webContentsId, state);
  return {
    logpoints: [...state.specs.values()].map((spec) =>
      toState(webContentsId, state, spec),
    ),
    autoResumed,
    ...(suspended ? { suspended } : {}),
  };
};

export const getBrowserLogpointHits = async (
  webContentsId: number,
  options: { logpointId?: string; limit?: number } = {},
): Promise<{
  hits: BrowserLogpointHit[];
  total: number;
  /** 尚无命中或求值出错的断点，用于区分「没绑上 / 没执行 / 表达式报错」。 */
  diagnostics?: BrowserLogpointState[];
  suspended?: string;
}> => {
  const state = states.get(webContentsId);
  if (!state) return { hits: [], total: 0 };
  const suspended = await ensureActive(webContentsId, state);
  const filtered = options.logpointId
    ? state.hits.filter((hit) => hit.logpointId === options.logpointId)
    : state.hits;
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const diagnostics = [...state.specs.values()]
    .filter((spec) => !options.logpointId || spec.id === options.logpointId)
    .map((spec) => toState(webContentsId, state, spec))
    .filter((item) => item.hits === 0 || item.lastError !== undefined);
  return {
    hits: filtered.slice(-limit),
    total: filtered.length,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(suspended ? { suspended } : {}),
  };
};

/** 清空命中并重新计数：断点换代后重新下发，页面内计数随之归零。 */
export const clearBrowserLogpointHits = (webContentsId: number): number => {
  const state = states.get(webContentsId);
  if (!state) return 0;
  const cleared = state.hits.length;
  state.hits = [];
  state.hitsBySpec.clear();
  state.errors.clear();
  for (const spec of state.specs.values()) {
    spec.nonce = newNonce();
    spec.rev += 1;
  }
  if (state.specs.size > 0) {
    void runQueued(state, async () => {
      const contents = getBrowserWebContents(webContentsId);
      if (contents.debugger.isAttached()) await reconcileAll(contents, state);
    }).catch(() => undefined);
  }
  return cleared;
};
