#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DOCS_ROOT = path.join(ROOT, "docs");
const DOCS_INDEX = path.join(DOCS_ROOT, "README.md");
const FEATURE_COVERAGE = path.join(DOCS_ROOT, "FEATURE_COVERAGE.md");
const LOCALES = ["zh-CN", "en"];
const ALLOWED_MERMAID_TYPES = [
  {
    name: "flowchart",
    pattern: /^flowchart\s+(?:TB|TD|BT|RL|LR)\b/,
  },
  { name: "sequence", pattern: /^sequenceDiagram\b/ },
  { name: "state", pattern: /^stateDiagram(?:-v2)?\b/ },
  { name: "er", pattern: /^erDiagram\b/ },
];
const FORBIDDEN_COVERAGE_STATUS = /^(?:缺失|待补|未覆盖|todo|missing|uncovered)(?:\b|\s|\/|$)/i;
const ENGLISH_PLACEHOLDER = /con\*{6,}/i;
const CJK_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const diagnostics = [];

const toPosix = (value) => value.split(path.sep).join("/");

const relativeToRoot = (filePath) => toPosix(path.relative(ROOT, filePath));

const addDiagnostic = (code, filePath, line, message) => {
  diagnostics.push({
    code,
    file: relativeToRoot(filePath),
    line,
    message,
  });
};

const readUtf8 = (filePath) => fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");

const walkMarkdownFiles = (directory) => {
  const files = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) =>
    toPosix(left).localeCompare(toPosix(right), "en")
  );
};

const parseFenceMarker = (line) => {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;

  return {
    character: match[1][0],
    length: match[1].length,
    info: match[2].trim(),
  };
};

const scanMarkdown = (filePath, source) => {
  const lines = source.split(/\r?\n/);
  const proseLines = [];
  const mermaidBlocks = [];
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = parseFenceMarker(line);

    if (!fence && marker) {
      fence = {
        character: marker.character,
        length: marker.length,
        info: marker.info.toLowerCase(),
        startLine: index + 1,
        content: [],
      };
      continue;
    }

    if (fence && marker) {
      const isClosingFence =
        marker.character === fence.character &&
        marker.length >= fence.length &&
        marker.info === "";
      if (isClosingFence) {
        if (fence.info === "mermaid") {
          mermaidBlocks.push({
            startLine: fence.startLine,
            content: fence.content,
          });
        }
        fence = null;
        continue;
      }
    }

    if (fence) {
      fence.content.push(line);
    } else {
      proseLines.push({ line: index + 1, text: line });
    }
  }

  if (fence) {
    const code = fence.info === "mermaid" ? "MERMAID_UNCLOSED" : "FENCE_UNCLOSED";
    addDiagnostic(
      code,
      filePath,
      fence.startLine,
      `Unclosed ${fence.info || "code"} fence.`
    );
  }

  return { proseLines, mermaidBlocks };
};

const stripInlineCode = (line) => {
  let result = line;
  let previous;
  do {
    previous = result;
    result = result.replace(/`[^`]*`/g, "");
  } while (result !== previous);
  return result;
};

const extractMarkdownTargets = (line) => {
  const targets = [];
  const withoutInlineCode = stripInlineCode(line);
  const inlineLink = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  const referenceLink = /^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/;
  let match;

  while ((match = inlineLink.exec(withoutInlineCode)) !== null) {
    targets.push(match[1]);
  }

  match = withoutInlineCode.match(referenceLink);
  if (match) targets.push(match[1]);

  return targets;
};

const decodeLinkPath = (value) => {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
};

const checkRelativeMarkdownLinks = (filePath, proseLines) => {
  for (const proseLine of proseLines) {
    for (const rawTarget of extractMarkdownTargets(proseLine.text)) {
      const target = rawTarget.replace(/^<|>$/g, "").trim();
      if (
        target === "" ||
        target.startsWith("#") ||
        target.startsWith("//") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target) ||
        /^[A-Za-z]:[\\/]/.test(target)
      ) {
        continue;
      }

      const pathOnly = target.split("#", 1)[0].split("?", 1)[0];
      if (!pathOnly.toLowerCase().endsWith(".md")) continue;

      const decodedPath = decodeLinkPath(pathOnly).replace(/[\\/]/g, path.sep);
      const resolvedPath = path.resolve(path.dirname(filePath), decodedPath);
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        addDiagnostic(
          "LINK_NOT_FOUND",
          filePath,
          proseLine.line,
          `Relative Markdown link does not exist: ${target}`
        );
      }
    }
  }
};

const localizedDocumentKey = (docsRelativePath, locale) => {
  const localePrefix = `${locale}/`;
  const withoutLocale = docsRelativePath.slice(localePrefix.length);
  const withoutExtension = withoutLocale.replace(/\.md$/i, "");
  const segments = withoutExtension.split("/");
  const numbers = [];

  for (const segment of segments) {
    const match = segment.match(/^(\d+)(?:-|$)/);
    if (!match) return null;
    numbers.push(String(Number.parseInt(match[1], 10)));
  }

  return numbers.join("/");
};

const checkLocalizedPairs = (markdownFiles) => {
  const byLocale = new Map(LOCALES.map((locale) => [locale, new Map()]));

  for (const filePath of markdownFiles) {
    const docsRelativePath = toPosix(path.relative(DOCS_ROOT, filePath));
    const locale = LOCALES.find((candidate) =>
      docsRelativePath.startsWith(`${candidate}/`)
    );
    if (!locale) continue;

    const key = localizedDocumentKey(docsRelativePath, locale);
    if (!key) {
      addDiagnostic(
        "LOCALE_KEY_INVALID",
        filePath,
        1,
        "Localized documents must use numeric category/document prefixes."
      );
      continue;
    }

    const localeMap = byLocale.get(locale);
    const existing = localeMap.get(key);
    if (existing) {
      addDiagnostic(
        "LOCALE_KEY_DUPLICATE",
        filePath,
        1,
        `Duplicate ${locale} documentation key ${key}; also used by ${relativeToRoot(existing)}.`
      );
    } else {
      localeMap.set(key, filePath);
    }
  }

  const allKeys = new Set();
  for (const localeMap of byLocale.values()) {
    for (const key of localeMap.keys()) allKeys.add(key);
  }

  for (const key of [...allKeys].sort()) {
    for (const locale of LOCALES) {
      if (!byLocale.get(locale).has(key)) {
        const counterpart = LOCALES
          .filter((candidate) => candidate !== locale)
          .map((candidate) => byLocale.get(candidate).get(key))
          .find(Boolean);
        addDiagnostic(
          "LOCALE_PAIR_MISSING",
          counterpart || DOCS_ROOT,
          1,
          `Documentation key ${key} has no ${locale} counterpart.`
        );
      }
    }
  }

  return allKeys.size;
};

const checkReadmeIndex = (markdownFiles, indexProseLines) => {
  if (!fs.existsSync(DOCS_INDEX)) {
    addDiagnostic("INDEX_MISSING", DOCS_INDEX, 1, "docs/README.md does not exist.");
    return;
  }

  const indexedFiles = new Set();
  for (const proseLine of indexProseLines) {
    for (const rawTarget of extractMarkdownTargets(proseLine.text)) {
      const target = rawTarget.replace(/^<|>$/g, "").trim();
      if (
        target === "" ||
        target.startsWith("#") ||
        target.startsWith("//") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target) ||
        /^[A-Za-z]:[\\/]/.test(target)
      ) {
        continue;
      }

      const pathOnly = target.split("#", 1)[0].split("?", 1)[0];
      if (!pathOnly.toLowerCase().endsWith(".md")) continue;

      const decodedPath = decodeLinkPath(pathOnly).replace(/[\\/]/g, path.sep);
      indexedFiles.add(path.resolve(path.dirname(DOCS_INDEX), decodedPath));
    }
  }

  for (const filePath of markdownFiles) {
    if (path.resolve(filePath) === path.resolve(DOCS_INDEX)) continue;

    if (!indexedFiles.has(path.resolve(filePath))) {
      const docsRelativePath = toPosix(path.relative(DOCS_ROOT, filePath));
      addDiagnostic(
        "INDEX_ENTRY_MISSING",
        DOCS_INDEX,
        1,
        `Index does not link to ${docsRelativePath}.`
      );
    }
  }
};

const stripEnglishExemptions = (line) =>
  stripInlineCode(line)
    .replace(/<!--.*?-->/g, "")
    .replace(/\]\(\s*(?:<[^>]+>|[^)]*)\)/g, "]()")
    .replace(/<https?:\/\/[^>]+>/gi, "")
    .replace(/https?:\/\/\S+/gi, "");

const checkEnglishProse = (filePath, proseLines) => {
  for (const proseLine of proseLines) {
    if (proseLine.text.includes("docs-check: allow-cjk")) continue;

    const stripped = stripEnglishExemptions(proseLine.text);
    if (ENGLISH_PLACEHOLDER.test(stripped)) {
      addDiagnostic(
        "EN_PLACEHOLDER",
        filePath,
        proseLine.line,
        "English prose contains the corrupted con********** placeholder pattern."
      );
    }
    if (CJK_TEXT.test(stripped)) {
      addDiagnostic(
        "EN_CJK_RESIDUE",
        filePath,
        proseLine.line,
        "English prose contains CJK text outside code/path exemptions."
      );
    }
  }
};

const checkMermaidBlocks = (filePath, mermaidBlocks) => {
  for (const block of mermaidBlocks) {
    const firstMeaningfulIndex = block.content.findIndex((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("%%");
    });

    if (firstMeaningfulIndex === -1) {
      addDiagnostic(
        "MERMAID_EMPTY",
        filePath,
        block.startLine,
        "Mermaid fence has no diagram declaration."
      );
      continue;
    }

    const declaration = block.content[firstMeaningfulIndex].trim();
    const supported = ALLOWED_MERMAID_TYPES.some(({ pattern }) =>
      pattern.test(declaration)
    );
    if (!supported) {
      addDiagnostic(
        "MERMAID_TYPE_UNSUPPORTED",
        filePath,
        block.startLine + firstMeaningfulIndex + 1,
        `Unsupported Mermaid declaration "${declaration}". Use flowchart, sequenceDiagram, stateDiagram-v2, or erDiagram.`
      );
    }
  }
};

const checkFeatureCoverageStatuses = () => {
  if (!fs.existsSync(FEATURE_COVERAGE)) {
    addDiagnostic(
      "COVERAGE_FILE_MISSING",
      FEATURE_COVERAGE,
      1,
      "docs/FEATURE_COVERAGE.md does not exist."
    );
    return 0;
  }

  const lines = readUtf8(FEATURE_COVERAGE).split(/\r?\n/);
  let recognizedRows = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;

    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim().replace(/^\*\*|\*\*$/g, ""));
    const status = cells.at(-1) || "";

    if (["C", "A", "R"].includes(status)) recognizedRows += 1;
    if (FORBIDDEN_COVERAGE_STATUS.test(status)) {
      addDiagnostic(
        "COVERAGE_STATUS_FORBIDDEN",
        FEATURE_COVERAGE,
        index + 1,
        `Forbidden incomplete coverage status: ${status}`
      );
    }
  }

  if (recognizedRows === 0) {
    addDiagnostic(
      "COVERAGE_ROWS_MISSING",
      FEATURE_COVERAGE,
      1,
      "No coverage rows with C, A, or R status were found."
    );
  }

  return recognizedRows;
};

const main = () => {
  if (!fs.existsSync(DOCS_ROOT) || !fs.statSync(DOCS_ROOT).isDirectory()) {
    console.error(`[docs-check] FAIL: documentation directory not found: ${DOCS_ROOT}`);
    process.exitCode = 1;
    return;
  }

  const markdownFiles = walkMarkdownFiles(DOCS_ROOT);
  const scans = new Map();

  for (const filePath of markdownFiles) {
    const scan = scanMarkdown(filePath, readUtf8(filePath));
    scans.set(filePath, scan);
    checkRelativeMarkdownLinks(filePath, scan.proseLines);
    checkMermaidBlocks(filePath, scan.mermaidBlocks);

    const docsRelativePath = toPosix(path.relative(DOCS_ROOT, filePath));
    if (docsRelativePath.startsWith("en/")) {
      checkEnglishProse(filePath, scan.proseLines);
    }
  }

  const localePairCount = checkLocalizedPairs(markdownFiles);
  checkReadmeIndex(markdownFiles, scans.get(DOCS_INDEX)?.proseLines || []);
  const coverageRowCount = checkFeatureCoverageStatuses();

  diagnostics.sort((left, right) =>
    left.file.localeCompare(right.file, "en") ||
    left.line - right.line ||
    left.code.localeCompare(right.code, "en")
  );

  if (diagnostics.length > 0) {
    console.error(
      `[docs-check] FAIL: ${diagnostics.length} issue(s) across ${markdownFiles.length} Markdown file(s).`
    );
    for (const diagnostic of diagnostics) {
      console.error(
        `- [${diagnostic.code}] ${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`
      );
    }
    console.error(
      "[docs-check] Fix the listed documents or add a narrowly scoped, explained CJK exemption."
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[docs-check] PASS: ${markdownFiles.length} Markdown file(s), ${localePairCount} bilingual pair(s), ${coverageRowCount} coverage row(s).`
  );
};

main();
