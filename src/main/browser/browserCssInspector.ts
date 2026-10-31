import {
  ensureWebContentsDebugger,
  getBrowserWebContents,
} from "../ipc/handlers/browserNetworkRecorder";

/**
 * 元素 CSS 级联检查（CDP CSS 域）：匹配规则（含 media 与源码位置）、
 * 内联样式、继承层级与 computed 值；属性按级联优先级标记 overloaded。
 */

export type CssStylesQuery = {
  selector?: string;
  backendNodeId?: number;
  /** 已解析的元素对象（帧内定位）；优先于 selector/backendNodeId。 */
  objectId?: string;
  /** 帧 CDP 会话；省略时使用根会话。 */
  sessionId?: string;
  pageIdx?: number;
  pageSize?: number;
};

export type CssRuleProperty = {
  name: string;
  value: string;
  important: boolean;
  overloaded: boolean;
};

export type CssRule = {
  selector: string;
  media?: string[];
  origin: string;
  source?: { url: string; line: number };
  properties: CssRuleProperty[];
};

export type CssInheritedLevel = {
  level: number;
  selector: string;
  properties: CssRuleProperty[];
};

export type CssStylesResult = {
  found: boolean;
  error?: string;
  element?: { tagName: string; id: string | null; classes: string[] };
  inline: CssRuleProperty[];
  rules: CssRule[];
  totalRules: number;
  pageIdx: number;
  pageSize: number;
  hasMore: boolean;
  inherited: CssInheritedLevel[];
  computed: Record<string, string>;
};

type RawProperty = {
  name?: unknown;
  value?: unknown;
  important?: unknown;
  disabled?: unknown;
  implicit?: unknown;
};

type RawRule = {
  selectorList?: { text?: unknown };
  origin?: unknown;
  sourceURL?: unknown;
  sourceLine?: unknown;
  media?: unknown;
  style?: { range?: { startLine?: unknown }; cssProperties?: unknown };
};

type RawMatchedEntry = { rule?: RawRule };
type RawInheritedEntry = {
  inlineStyle?: { cssProperties?: unknown };
  matchedCSSRules?: RawMatchedEntry[];
};

const EMPTY_RESULT = (pageIdx: number, pageSize: number): CssStylesResult => ({
  found: false,
  inline: [],
  rules: [],
  totalRules: 0,
  pageIdx,
  pageSize,
  hasMore: false,
  inherited: [],
  computed: {},
});

const toProperties = (value: unknown): CssRuleProperty[] => {
  const out: CssRuleProperty[] = [];
  if (!Array.isArray(value)) {
    return out;
  }
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    const property = raw as RawProperty;
    if (
      typeof property.name !== "string" ||
      property.disabled === true ||
      property.implicit === true
    ) {
      continue;
    }
    out.push({
      name: property.name,
      value: typeof property.value === "string" ? property.value : "",
      important: property.important === true,
      overloaded: false,
    });
  }
  return out;
};

const toRule = (rule: RawRule | undefined): CssRule | null => {
  if (!rule) {
    return null;
  }
  const selector =
    typeof rule.selectorList?.text === "string" ? rule.selectorList.text : "?";
  const media: string[] = [];
  if (Array.isArray(rule.media)) {
    for (const entry of rule.media) {
      const text = (entry as { text?: unknown } | null)?.text;
      if (typeof text === "string") {
        media.push(text);
      }
    }
  }
  const style = rule.style ?? {};
  const range = style.range;
  const line =
    typeof range?.startLine === "number"
      ? range.startLine + 1
      : typeof rule.sourceLine === "number"
        ? rule.sourceLine + 1
        : undefined;
  const url = typeof rule.sourceURL === "string" ? rule.sourceURL : undefined;
  return {
    selector,
    ...(media.length > 0 ? { media } : {}),
    origin: typeof rule.origin === "string" ? rule.origin : "regular",
    ...(url !== undefined ? { source: { url, line: line ?? 0 } } : {}),
    properties: toProperties(style.cssProperties),
  };
};

const markOverloaded = (
  inline: CssRuleProperty[],
  matchedRules: CssRule[],
): void => {
  const highToLow = [...matchedRules].reverse();
  const seenImportant = new Set<string>();
  const processImportant = (properties: CssRuleProperty[]): void => {
    for (const property of properties) {
      if (!property.important) {
        continue;
      }
      if (seenImportant.has(property.name)) {
        property.overloaded = true;
      } else {
        seenImportant.add(property.name);
      }
    }
  };
  processImportant(inline);
  for (const rule of highToLow) {
    processImportant(rule.properties);
  }
  const seenNormal = new Set<string>();
  const processNormal = (properties: CssRuleProperty[]): void => {
    for (const property of properties) {
      if (property.important) {
        continue;
      }
      if (seenImportant.has(property.name) || seenNormal.has(property.name)) {
        property.overloaded = true;
      } else {
        seenNormal.add(property.name);
      }
    }
  };
  processNormal(inline);
  for (const rule of highToLow) {
    processNormal(rule.properties);
  }
};

export const getCssStyles = async (
  webContentsId: number,
  query: CssStylesQuery,
): Promise<CssStylesResult> => {
  const pageIdx = Math.max(0, query.pageIdx ?? 0);
  const pageSize = Math.max(1, query.pageSize ?? 10);
  const contents = getBrowserWebContents(webContentsId);
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  const send = (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> =>
    contents.debugger.sendCommand(method, params, query.sessionId);
  await send("DOM.enable", {});
  await send("CSS.enable", {});
  // CDP requires the document to be requested before backend nodes can be pushed.
  const doc = (await send("DOM.getDocument", { depth: 0 })) as {
    root?: { nodeId?: number };
  };

  let nodeId = 0;
  if (query.objectId) {
    const requested = (await send("DOM.requestNode", {
      objectId: query.objectId,
    })) as { nodeId?: number };
    nodeId = requested.nodeId ?? 0;
  } else if (
    typeof query.backendNodeId === "number" &&
    query.backendNodeId > 0
  ) {
    const pushed = (await send("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [query.backendNodeId],
    })) as { nodeIds?: number[] };
    nodeId = pushed.nodeIds?.[0] ?? 0;
  } else if (query.selector) {
    const rootId = doc.root?.nodeId;
    if (typeof rootId !== "number") {
      throw new Error("Failed to resolve the page document");
    }
    const found = (await send("DOM.querySelector", {
      nodeId: rootId,
      selector: query.selector,
    })) as { nodeId?: number };
    nodeId = found.nodeId ?? 0;
  } else {
    throw new Error("Either selector or ref is required for get_css_styles");
  }
  if (!nodeId) {
    return { ...EMPTY_RESULT(pageIdx, pageSize), error: "Element not found" };
  }

  const described = (await send("DOM.describeNode", { nodeId })) as {
    node?: { nodeName?: unknown; attributes?: unknown };
  };
  const attributes = Array.isArray(described.node?.attributes)
    ? described.node?.attributes
    : [];
  const attributeMap = new Map<string, string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    attributeMap.set(String(attributes[index]), String(attributes[index + 1]));
  }
  const element = {
    tagName: String(described.node?.nodeName ?? "?").toLowerCase(),
    id: attributeMap.get("id") ?? null,
    classes: (attributeMap.get("class") ?? "")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean),
  };

  const matched = (await send("CSS.getMatchedStylesForNode", { nodeId })) as {
    inlineStyle?: { cssProperties?: unknown };
    matchedCSSRules?: RawMatchedEntry[];
    inherited?: RawInheritedEntry[];
  };
  const computedRaw = (await send("CSS.getComputedStyleForNode", {
    nodeId,
  })) as { computedStyle?: { name?: unknown; value?: unknown }[] };

  const inline = toProperties(matched.inlineStyle?.cssProperties);
  const allRules: CssRule[] = [];
  for (const entry of matched.matchedCSSRules ?? []) {
    const rule = toRule(entry.rule);
    if (rule) {
      allRules.push(rule);
    }
  }
  markOverloaded(inline, allRules);

  const start = pageIdx * pageSize;
  const rules = allRules.slice(start, start + pageSize);

  const inherited: CssInheritedLevel[] = [];
  const inheritedSources = matched.inherited ?? [];
  for (let index = 0; index < Math.min(inheritedSources.length, 2); index++) {
    const level = inheritedSources[index];
    const inlineProps = toProperties(level.inlineStyle?.cssProperties);
    for (const property of inlineProps.slice(0, 40)) {
      inherited.push({
        level: index + 1,
        selector: "(inline)",
        properties: [property],
      });
    }
    for (const entry of (level.matchedCSSRules ?? []).slice(0, 10)) {
      const rule = toRule(entry.rule);
      if (rule) {
        inherited.push({
          level: index + 1,
          selector: rule.selector,
          properties: rule.properties,
        });
      }
    }
  }

  const computed: Record<string, string> = {};
  for (const entry of computedRaw.computedStyle ?? []) {
    if (typeof entry.name === "string" && typeof entry.value === "string") {
      computed[entry.name] = entry.value;
    }
  }

  return {
    found: true,
    element,
    inline,
    rules,
    totalRules: allRules.length,
    pageIdx,
    pageSize,
    hasMore: start + rules.length < allRules.length,
    inherited,
    computed,
  };
};
