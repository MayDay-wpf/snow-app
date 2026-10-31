import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import {
  ensureWebContentsDebugger,
  getBrowserWebContents,
} from "../ipc/handlers/browserNetworkRecorder";
import { queryConsoleRecords } from "../ipc/handlers/browserConsoleRecorder";

/**
 * 页面审计：axe-core 无障碍扫描（注入运行）+ 轻量 SEO / 最佳实践检查 +
 * 控制台错误统计。axe-core 作为运行依赖打包（node_modules/axe-core）。
 */

export type AuditCategories = "accessibility" | "seo" | "best-practices";

/** 帧作用域审计：在目标帧的 execution context 内运行，不读取其他文档。 */
export type AuditFrameScope = {
  sessionId?: string;
  contextId: number;
  cdpFrameId: string;
  url: string;
  title: string;
};

export type AuditCheck = {
  id: string;
  severity: "error" | "warning" | "info";
  message: string;
};

export type A11yViolation = {
  id: string;
  impact: string;
  help: string;
  helpUrl: string;
  nodeCount: number;
  nodes: { target: string; failureSummary: string }[];
};

export type AuditResult = {
  url: string;
  title: string;
  accessibility?: {
    engine: string;
    version: string;
    violations: A11yViolation[];
    violationCount: number;
    passesCount: number;
    incompleteCount: number;
  };
  seo?: { checks: AuditCheck[]; issueCount: number };
  bestPractices?: { checks: AuditCheck[]; issueCount: number };
  consoleErrors: number;
};

const AUDIT_TIMEOUT_MS = 25_000;

let axeSourceCache: string | null = null;

const loadAxeSource = async (): Promise<string> => {
  if (axeSourceCache) {
    return axeSourceCache;
  }
  const path = join(app.getAppPath(), "node_modules", "axe-core", "axe.min.js");
  axeSourceCache = await readFile(path, "utf8");
  return axeSourceCache;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

type RawAxeResult = {
  violations?: {
    id?: unknown;
    impact?: unknown;
    help?: unknown;
    helpUrl?: unknown;
    nodes?: { target?: unknown; failureSummary?: unknown }[];
  }[];
  passes?: unknown[];
  incomplete?: unknown[];
  testEngine?: { name?: unknown; version?: unknown };
};

const runAccessibilityAudit = async (
  contents: Electron.WebContents,
  frame?: AuditFrameScope,
): Promise<AuditResult["accessibility"]> => {
  const axeSource = await loadAxeSource();
  const evaluated = (await withTimeout(
    contents.debugger.sendCommand(
      "Runtime.evaluate",
      {
        ...(frame ? { contextId: frame.contextId } : {}),
        expression: `(async () => {
        ${axeSource}
        const engine = window.axe;
        if (!engine) { throw new Error('axe-core did not load'); }
        const results = await engine.run(document, { resultTypes: ['violations'] });
        return JSON.stringify({
          violations: results.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            help: violation.help,
            helpUrl: violation.helpUrl,
            nodes: violation.nodes.slice(0, 5).map((node) => ({
              target: Array.isArray(node.target) ? node.target.join(' ') : String(node.target || ''),
              failureSummary: String(node.failureSummary || '').slice(0, 300),
            })),
            nodeCount: violation.nodes.length,
          })),
          passesCount: results.passes.length,
          incompleteCount: results.incomplete.length,
          testEngine: { name: results.testEngine.name, version: results.testEngine.version },
        });
      })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      frame?.sessionId,
    ),
    AUDIT_TIMEOUT_MS,
    `Accessibility audit timed out after ${AUDIT_TIMEOUT_MS}ms`,
  )) as {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: unknown } };
  };
  if (evaluated.exceptionDetails) {
    const description = evaluated.exceptionDetails.exception?.description;
    throw new Error(
      typeof description === "string"
        ? `Accessibility audit failed: ${description.slice(0, 300)}`
        : "Accessibility audit failed",
    );
  }
  const value = evaluated.result?.value;
  if (typeof value !== "string") {
    throw new Error("Accessibility audit returned no data");
  }
  const raw = JSON.parse(value) as RawAxeResult;
  const violations: A11yViolation[] = (raw.violations ?? []).map((entry) => ({
    id: typeof entry.id === "string" ? entry.id : "unknown",
    impact: typeof entry.impact === "string" ? entry.impact : "minor",
    help: typeof entry.help === "string" ? entry.help : "",
    helpUrl: typeof entry.helpUrl === "string" ? entry.helpUrl : "",
    nodeCount: Array.isArray(entry.nodes) ? entry.nodes.length : 0,
    nodes: (entry.nodes ?? []).map((node) => ({
      target: typeof node.target === "string" ? node.target : "",
      failureSummary:
        typeof node.failureSummary === "string" ? node.failureSummary : "",
    })),
  }));
  return {
    engine:
      typeof raw.testEngine?.name === "string" ? raw.testEngine.name : "axe",
    version:
      typeof raw.testEngine?.version === "string" ? raw.testEngine.version : "",
    violations,
    violationCount: violations.reduce((sum, entry) => sum + entry.nodeCount, 0),
    passesCount: Array.isArray(raw.passes) ? raw.passes.length : 0,
    incompleteCount: Array.isArray(raw.incomplete) ? raw.incomplete.length : 0,
  };
};

type PageFacts = {
  title: string | null;
  metaDescription: string | null;
  htmlLang: string | null;
  viewportMeta: string | null;
  h1Count: number;
  duplicateIds: number;
  images: number;
  imagesWithoutAlt: number;
  secureContext: boolean;
  doctype: string | null;
  charset: string | null;
  canonical: string | null;
  ogTitle: string | null;
};

const collectPageFacts = async (
  contents: Electron.WebContents,
  frame?: AuditFrameScope,
): Promise<PageFacts> => {
  const evaluated = (await withTimeout(
    contents.debugger.sendCommand(
      "Runtime.evaluate",
      {
        ...(frame ? { contextId: frame.contextId } : {}),
        expression: `(() => {
        const ids = new Set();
        let duplicateIds = 0;
        for (const element of document.querySelectorAll('[id]')) {
          if (ids.has(element.id)) duplicateIds += 1;
          else ids.add(element.id);
        }
        return {
          title: document.title || null,
          metaDescription: document.querySelector('meta[name="description"]')?.content || null,
          htmlLang: document.documentElement.getAttribute('lang') || null,
          viewportMeta: document.querySelector('meta[name="viewport"]')?.content || null,
          h1Count: document.querySelectorAll('h1').length,
          duplicateIds,
          images: document.images.length,
          imagesWithoutAlt: Array.from(document.images).filter((img) => !img.hasAttribute('alt')).length,
          secureContext: window.isSecureContext === true,
          doctype: document.doctype ? document.doctype.name : null,
          charset: document.characterSet || null,
          canonical: document.querySelector('link[rel="canonical"]')?.href || null,
          ogTitle: document.querySelector('meta[property="og:title"]')?.content || null,
        };
      })()`,
        returnByValue: true,
      },
      frame?.sessionId,
    ),
    AUDIT_TIMEOUT_MS,
    "Page facts collection timed out",
  )) as { result?: { value?: unknown } };
  const value = evaluated.result?.value;
  if (value === null || typeof value !== "object") {
    throw new Error("Page facts collection returned no data");
  }
  const raw = value as Record<string, unknown>;
  const str = (key: string): string | null =>
    typeof raw[key] === "string" && raw[key] !== ""
      ? (raw[key] as string)
      : null;
  const num = (key: string): number =>
    typeof raw[key] === "number" ? (raw[key] as number) : 0;
  return {
    title: str("title"),
    metaDescription: str("metaDescription"),
    htmlLang: str("htmlLang"),
    viewportMeta: str("viewportMeta"),
    h1Count: num("h1Count"),
    duplicateIds: num("duplicateIds"),
    images: num("images"),
    imagesWithoutAlt: num("imagesWithoutAlt"),
    secureContext: raw.secureContext === true,
    doctype: str("doctype"),
    charset: str("charset"),
    canonical: str("canonical"),
    ogTitle: str("ogTitle"),
  };
};

const buildSeoChecks = (facts: PageFacts): AuditCheck[] => {
  const checks: AuditCheck[] = [];
  if (!facts.title) {
    checks.push({
      id: "title",
      severity: "error",
      message: "Missing <title> tag",
    });
  } else if (facts.title.length < 10 || facts.title.length > 60) {
    checks.push({
      id: "title",
      severity: "warning",
      message: `Title length is ${facts.title.length} characters (recommended 10-60)`,
    });
  }
  if (!facts.metaDescription) {
    checks.push({
      id: "meta-description",
      severity: "warning",
      message: "Missing meta description",
    });
  }
  if (facts.h1Count === 0) {
    checks.push({
      id: "h1",
      severity: "warning",
      message: "No <h1> heading found",
    });
  } else if (facts.h1Count > 1) {
    checks.push({
      id: "h1",
      severity: "info",
      message: `${facts.h1Count} <h1> headings found (a single h1 is recommended)`,
    });
  }
  if (!facts.htmlLang) {
    checks.push({
      id: "html-lang",
      severity: "warning",
      message: "Missing lang attribute on <html>",
    });
  }
  if (!facts.viewportMeta) {
    checks.push({
      id: "viewport",
      severity: "warning",
      message: "Missing meta viewport (mobile rendering)",
    });
  }
  if (!facts.canonical) {
    checks.push({
      id: "canonical",
      severity: "info",
      message: "No canonical link",
    });
  }
  if (!facts.ogTitle) {
    checks.push({
      id: "open-graph",
      severity: "info",
      message: "No Open Graph title (social sharing)",
    });
  }
  return checks;
};

const buildBestPracticeChecks = (facts: PageFacts): AuditCheck[] => {
  const checks: AuditCheck[] = [];
  if (!facts.secureContext) {
    checks.push({
      id: "secure-context",
      severity: "warning",
      message: "Page is not a secure context (HTTPS)",
    });
  }
  if (facts.doctype !== "html") {
    checks.push({
      id: "doctype",
      severity: "error",
      message: "Missing or non-html doctype (quirks mode)",
    });
  }
  if (!facts.charset) {
    checks.push({
      id: "charset",
      severity: "warning",
      message: "Missing document character set",
    });
  }
  if (facts.duplicateIds > 0) {
    checks.push({
      id: "duplicate-ids",
      severity: "warning",
      message: `${facts.duplicateIds} duplicate id attribute(s)`,
    });
  }
  if (facts.imagesWithoutAlt > 0) {
    checks.push({
      id: "image-alt",
      severity: "warning",
      message: `${facts.imagesWithoutAlt} of ${facts.images} image(s) without alt attribute`,
    });
  }
  return checks;
};

export const runBrowserAudit = async (
  webContentsId: number,
  categories: AuditCategories[],
  frame?: AuditFrameScope,
): Promise<AuditResult> => {
  const contents = getBrowserWebContents(webContentsId);
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  const selected = new Set(categories);
  const result: AuditResult = {
    url: frame?.url ?? contents.getURL(),
    title: frame?.title ?? contents.getTitle(),
    consoleErrors: queryConsoleRecords(webContentsId, {
      level: 3,
      includePreserved: true,
      ...(frame ? { cdpFrameId: frame.cdpFrameId } : {}),
    }).total,
  };
  if (
    selected.has("accessibility") ||
    selected.has("seo") ||
    selected.has("best-practices")
  ) {
    const facts = await collectPageFacts(contents, frame);
    if (selected.has("accessibility")) {
      result.accessibility = await runAccessibilityAudit(contents, frame);
    }
    if (selected.has("seo")) {
      const checks = buildSeoChecks(facts);
      result.seo = {
        checks,
        issueCount: checks.filter((check) => check.severity !== "info").length,
      };
    }
    if (selected.has("best-practices")) {
      const checks = buildBestPracticeChecks(facts);
      result.bestPractices = {
        checks,
        issueCount: checks.filter((check) => check.severity !== "info").length,
      };
    }
  }
  return result;
};
