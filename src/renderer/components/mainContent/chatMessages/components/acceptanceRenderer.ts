import { escapeCodeHtml } from "../../../../utils/syntaxHighlight";

const STATUSES = ["completed", "incomplete", "blocked", "unverified"] as const;
type AcceptanceStatus = (typeof STATUSES)[number];
type AcceptanceItem = {
  id: string;
  status: AcceptanceStatus;
  observation?: string;
  reason?: string;
  evidence?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isItem = (value: unknown): value is AcceptanceItem =>
  isRecord(value) &&
  typeof value.id === "string" &&
  value.id.trim().length > 0 &&
  STATUSES.includes(value.status as AcceptanceStatus) &&
  (value.observation === undefined || typeof value.observation === "string") &&
  (value.reason === undefined || typeof value.reason === "string") &&
  (value.evidence === undefined ||
    (Array.isArray(value.evidence) &&
      value.evidence.length <= 100 &&
      value.evidence.every((entry) => typeof entry === "string")));

const label = (key: string): string =>
  `<span data-acceptance-label="${key}"></span>`;

/** Only closed, bounded, valid receipts become a presentation card; never verify evidence here. */
export const renderAcceptanceBlock = (source: string): string | null => {
  if (source.length > 100_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.items) ||
    parsed.items.length === 0 ||
    parsed.items.length > 100 ||
    !parsed.items.every(isItem)
  )
    return null;

  const items: AcceptanceItem[] = parsed.items;
  const completed = items.filter((item) => item.status === "completed").length;
  const rows = items
    .map((item) => {
      const observation = item.observation
        ? `<div class="md-acceptance-observation">${escapeCodeHtml(item.observation)}</div>`
        : "";
      const reason = item.reason
        ? `<div class="md-acceptance-reason">${label("reason")}<span>${escapeCodeHtml(item.reason)}</span></div>`
        : "";
      const evidence = item.evidence?.length
        ? `<div class="md-acceptance-evidence">${label("evidence")}${item.evidence
            .map(
              (entry) =>
                `<span class="md-acceptance-evidence-id">${escapeCodeHtml(entry)}</span>`,
            )
            .join("")}</div>`
        : "";
      return (
        `<li class="md-acceptance-item" data-status="${item.status}">` +
        `<div class="md-acceptance-item-header"><span class="md-acceptance-id">${escapeCodeHtml(item.id)}</span>` +
        `<span class="md-acceptance-status">${label(item.status)}</span></div>` +
        observation +
        reason +
        evidence +
        `</li>`
      );
    })
    .join("");

  const note =
    typeof parsed.note === "string"
      ? `<div class="md-acceptance-note">${escapeCodeHtml(parsed.note)}</div>`
      : "";
  return (
    `<section class="md-acceptance">` +
    `<div class="md-acceptance-bar">` +
    `<span class="md-acceptance-rule" aria-hidden="true"></span>` +
    `<div class="md-acceptance-cluster">` +
    `<button class="md-acceptance-toggle" type="button" aria-expanded="false">` +
    `<svg class="md-acceptance-chevron" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>` +
    `<span class="md-acceptance-title">${label("title")}</span>` +
    `<span class="md-acceptance-count" data-completed="${completed}" data-total="${items.length}"></span>` +
    `</button>` +
    `<button class="md-acceptance-copy" type="button">` +
    `<span data-acceptance-label="copy"></span><span class="md-acceptance-copied" data-acceptance-label="copied"></span>` +
    `</button>` +
    `</div>` +
    `<span class="md-acceptance-rule" aria-hidden="true"></span>` +
    `</div>` +
    `<div class="md-acceptance-body">` +
    `<ul class="md-acceptance-items">${rows}</ul>${note}` +
    `</div></section>`
  );
};

/** Copy the localized reading view, not the transport payload. */
export const getAcceptanceReportText = (block: Element): string => {
  const text = (selector: string, root: Element = block): string =>
    root.querySelector(selector)?.textContent?.trim() ?? "";
  const rows = Array.from(
    block.querySelectorAll(".md-acceptance-item"),
    (item) =>
      [
        [text(".md-acceptance-id", item), text(".md-acceptance-status", item)]
          .filter(Boolean)
          .join(" · "),
        text(".md-acceptance-observation", item),
        Array.from(
          item.querySelectorAll(".md-acceptance-reason > *"),
          (node) => node.textContent,
        ).join(": "),
        Array.from(
          item.querySelectorAll(".md-acceptance-evidence > *"),
          (node) => node.textContent,
        ).join(" "),
      ]
        .filter(Boolean)
        .join("\n"),
  );
  return [
    text(".md-acceptance-title"),
    text(".md-acceptance-count"),
    ...rows,
    text(".md-acceptance-note"),
  ]
    .filter(Boolean)
    .join("\n\n");
};

/** Keep worker HTML/cache language-neutral; localize after commits and locale changes. */
export const localizeAcceptanceBlocks = (
  root: HTMLElement,
  translate: (key: string, params?: Record<string, string | number>) => string,
): void => {
  root
    .querySelectorAll<HTMLElement>("[data-acceptance-label]")
    .forEach((node) => {
      const text = translate(
        `markdown.acceptance.${node.dataset.acceptanceLabel}`,
      );
      if (node.textContent !== text) node.textContent = text;
    });
  root.querySelectorAll<HTMLElement>(".md-acceptance-count").forEach((node) => {
    const text = translate("markdown.acceptance.count", {
      completed: node.dataset.completed ?? "0",
      total: node.dataset.total ?? "0",
    });
    if (node.textContent !== text) node.textContent = text;
  });
};
