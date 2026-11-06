import type { SnowRemoteSkill } from "../renderer/types/remoteControl";
import { fetchSkills, searchMentionFiles, type MentionFileItem } from "./api";
import { $, escapeHtml } from "./dom";
import { getFileIconMarkup } from "./fileIcons";
import { t } from "./i18n";
import { iconMarkup } from "./icons";
import { notifyInputChanged } from "./inputBridge";
import { showNotice } from "./notice";

/**
 * 输入框引用（`@` 文件 / 目录、`#` 技能）：
 * - 触发符号只作搜索入口，选定后从文本里移除，改为输入框上方的引用 chip；
 * - 发送时把 chip 编码成与桌面输入区一致的标签（`@@file:` / `@@dir:` /
 *   `@@skill:`），由桌面端的消息分段解析统一渲染，并触发技能的手动执行；
 * - 撤回待发送消息时把标签还原成 chip，输入框不出现编码原文。
 */
type FileReference = {
  kind: "file" | "dir";
  path: string;
  name: string;
  label: string;
  tag: string;
};

type SkillReference = {
  kind: "skill";
  skillId: string;
  name: string;
  label: string;
  tag: string;
};

type MentionReference = FileReference | SkillReference;
type MentionMode = "file" | "skill";

/** 引用数量上限：与附件上限同一量级，避免单条消息标签过长。 */
const MAX_REFERENCES = 8;
/** 技能列表缓存时长：同一项目内连续引用不必每次回源。 */
const SKILL_CACHE_TTL_MS = 60_000;
const SEARCH_DEBOUNCE_MS = 180;
const MAX_SKILL_RESULTS = 30;
/** `@` / `#` 触发词：行首或空白之后，直到下一个空白 / 触发符。 */
const TRIGGER_PATTERN = /(?:^|\s)([@#])([^\s@#]*)$/;
const FILE_TAG_PATTERN = /@@(file|dir):([^@]+?)@@/g;
const SKILL_TAG_PATTERN = /@@skill:(\{[\s\S]*?\})@@/g;
const LINE_SUFFIX_PATTERN = /^(?:L\d+(?:-L\d+)?)(?:,(?:L\d+(?:-L\d+)?))*$/;

let references: MentionReference[] = [];
let isOpen = false;
let mode: MentionMode = "file";
let activeQuery = "";
let triggerStart = -1;
let searchSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

let fileItems: MentionFileItem[] = [];
let fileLoading = false;
let fileError = false;
let remoteWorkspace = false;
/** 当前工作区 id：文件搜索按它解析路径，不接受客户端直传路径。 */
let workspaceDirectoryId = "";

let skills: SnowRemoteSkill[] = [];
let skillsLoadedAt = 0;
let skillsPending = false;
let skillsError = false;
let matchedSkills: SnowRemoteSkill[] = [];

// ── 引用 chip ──────────────────────────────────────────────────────────────

const referenceIcon = (reference: MentionReference): string =>
  reference.kind === "skill"
    ? iconMarkup("sparkles")
    : getFileIconMarkup(reference.name, {
        isDirectory: reference.kind === "dir",
        size: 14,
      });

const renderReferences = (): void => {
  const strip = $("referenceStrip");
  strip.className = "reference-strip" + (references.length ? " has-items" : "");
  strip.innerHTML = references
    .map((reference, index) => {
      const removeLabel = escapeHtml(t("remote.mention.remove"));
      return (
        `<span class="reference-chip ${reference.kind}">` +
        `<span class="reference-chip-icon">${referenceIcon(reference)}</span>` +
        `<span class="reference-chip-name" title="${escapeHtml(reference.label)}">${escapeHtml(reference.label)}</span>` +
        `<button class="reference-chip-remove" type="button" data-remove-reference="${index}" aria-label="${removeLabel}">${iconMarkup("x")}</button>` +
        `</span>`
      );
    })
    .join("");
};

const addReference = (reference: MentionReference): boolean => {
  if (references.some((item) => item.tag === reference.tag)) {
    showNotice(t("remote.mention.duplicate"));
    return false;
  }
  if (references.length >= MAX_REFERENCES) {
    showNotice(t("remote.mention.maxCount", { count: MAX_REFERENCES }), true);
    return false;
  }
  references.push(reference);
  renderReferences();
  return true;
};

// ── 输入框触发词 ──────────────────────────────────────────────────────────

const syncInputHeight = (): void => {
  const input = $<HTMLTextAreaElement>("input");
  input.style.height = "40px";
  input.style.height = Math.min(150, Math.max(40, input.scrollHeight)) + "px";
};

/** 从输入框移除 `@query` / `#query`，光标停在触发词原位置。 */
const stripTrigger = (): void => {
  const input = $<HTMLTextAreaElement>("input");
  if (triggerStart < 0) return;
  const caret = input.selectionStart ?? input.value.length;
  const start = Math.min(triggerStart, input.value.length);
  const end = Math.max(start, Math.min(caret, input.value.length));
  input.value = input.value.slice(0, start) + input.value.slice(end);
  input.setSelectionRange(start, start);
  syncInputHeight();
  notifyInputChanged();
};

// ── 弹层渲染 ──────────────────────────────────────────────────────────────

const popupMeta = (text: string): void => {
  $("mentionPopupMeta").textContent = text;
};

const emptyRow = (text: string, kind = ""): string =>
  `<div class="mention-empty${kind ? " " + kind : ""}">${escapeHtml(text)}</div>`;

const fileRow = (item: MentionFileItem, index: number): string => {
  const name = item.isDirectory ? item.name + "/" : item.name;
  const separator = item.relativePath.lastIndexOf("/");
  const parent = separator > 0 ? item.relativePath.slice(0, separator + 1) : "";
  const detail = parent
    ? `<small>${escapeHtml(parent)}</small>`
    : item.isDirectory
      ? `<small>${escapeHtml(t("remote.mention.directory"))}</small>`
      : "";
  return (
    `<button class="mention-row" type="button" role="option" data-mention-file="${index}">` +
    `<span class="mention-row-icon">${getFileIconMarkup(item.name, {
      isDirectory: item.isDirectory,
      size: 16,
    })}</span>` +
    `<span class="mention-row-main"><b>${escapeHtml(name)}</b>${detail}</span>` +
    `</button>`
  );
};

const renderFileList = (): void => {
  const list = $("mentionList");
  if (fileError) {
    popupMeta("");
    list.innerHTML = emptyRow(t("remote.mention.searchFailed"), "error");
    return;
  }
  if (remoteWorkspace) {
    popupMeta("");
    list.innerHTML = emptyRow(t("remote.mention.remoteUnsupported"));
    return;
  }
  if (fileLoading && fileItems.length === 0) {
    popupMeta("");
    list.innerHTML = `<div class="mention-empty"><span class="mention-spinner">${iconMarkup("loader-circle")}</span>${escapeHtml(t("remote.mention.searching"))}</div>`;
    return;
  }
  popupMeta(
    fileItems.length
      ? t("remote.mention.resultCount", { count: fileItems.length })
      : "",
  );
  list.innerHTML =
    fileItems.length === 0
      ? emptyRow(
          activeQuery.trim()
            ? t("remote.mention.noResults")
            : t("remote.mention.noEntries"),
        )
      : fileItems.map(fileRow).join("");
};

const skillMatches = (skill: SnowRemoteSkill): boolean => {
  const needle = activeQuery.trim().toLowerCase();
  if (!needle) return true;
  return (
    skill.name.toLowerCase().includes(needle) ||
    skill.id.toLowerCase().includes(needle) ||
    (skill.description || "").toLowerCase().includes(needle)
  );
};

const renderSkillList = (): void => {
  const list = $("mentionList");
  if (skillsError) {
    popupMeta("");
    list.innerHTML = emptyRow(t("remote.mention.skillLoadFailed"), "error");
    return;
  }
  if (skillsPending) {
    popupMeta("");
    list.innerHTML = `<div class="mention-empty"><span class="mention-spinner">${iconMarkup("loader-circle")}</span>${escapeHtml(t("remote.mention.searching"))}</div>`;
    return;
  }
  const matched = skills.filter(skillMatches).slice(0, MAX_SKILL_RESULTS);
  matchedSkills = matched;
  popupMeta(
    matched.length
      ? t("remote.mention.resultCount", { count: matched.length })
      : "",
  );
  if (skills.length === 0) {
    list.innerHTML = emptyRow(t("remote.mention.noSkills"));
    return;
  }
  list.innerHTML =
    matched.length === 0
      ? emptyRow(t("remote.mention.noResults"))
      : matched
          .map((skill, index) => {
            const location =
              skill.location === "project"
                ? t("remote.mention.skillProject")
                : t("remote.mention.skillGlobal");
            const detail = skill.description
              ? `${location} · ${skill.description}`
              : location;
            return (
              `<button class="mention-row skill" type="button" role="option" data-mention-skill="${index}">` +
              `<span class="mention-row-icon skill">${iconMarkup("sparkles")}</span>` +
              `<span class="mention-row-main"><b>${escapeHtml(skill.name || skill.id)}</b><small>${escapeHtml(detail)}</small></span>` +
              `</button>`
            );
          })
          .join("");
};

// ── 数据加载 ──────────────────────────────────────────────────────────────

const runFileSearch = (query: string): void => {
  const seq = ++searchSeq;
  fileLoading = true;
  fileError = false;
  renderFileList();
  searchTimer = setTimeout(
    async () => {
      searchTimer = null;
      try {
        const result = await searchMentionFiles(workspaceDirectoryId, query);
        if (seq !== searchSeq || !isOpen || mode !== "file") return;
        fileItems = Array.isArray(result.items) ? result.items : [];
        remoteWorkspace = result.remote === true;
        fileLoading = false;
        renderFileList();
      } catch {
        if (seq !== searchSeq || !isOpen || mode !== "file") return;
        fileLoading = false;
        fileError = true;
        renderFileList();
      }
    },
    query ? SEARCH_DEBOUNCE_MS : 0,
  );
};

const ensureSkills = async (): Promise<void> => {
  if (skillsPending) return;
  if (skills.length > 0 && Date.now() - skillsLoadedAt < SKILL_CACHE_TTL_MS) {
    renderSkillList();
    return;
  }
  skillsPending = true;
  skillsError = false;
  renderSkillList();
  try {
    const result = await fetchSkills();
    skills = (Array.isArray(result.skills) ? result.skills : []).filter(
      (skill) => skill.enabled,
    );
    skillsLoadedAt = Date.now();
  } catch {
    skills = [];
    skillsError = true;
  } finally {
    skillsPending = false;
    if (isOpen && mode === "skill") renderSkillList();
  }
};

// ── 打开 / 关闭 ───────────────────────────────────────────────────────────

const applyQuery = (
  nextMode: MentionMode,
  query: string,
  start: number,
): void => {
  const switched = !isOpen || mode !== nextMode;
  mode = nextMode;
  activeQuery = query;
  triggerStart = start;
  if (!isOpen || switched) {
    isOpen = true;
    $("mentionPopup").hidden = false;
    $("mentionPopupTitle").textContent =
      mode === "skill"
        ? t("remote.mention.skillsTitle")
        : t("remote.mention.filesTitle");
  }
  if (switched) {
    fileItems = [];
    fileError = false;
    remoteWorkspace = false;
    skillsError = false;
    if (mode === "skill") {
      void ensureSkills();
      renderSkillList();
    } else {
      runFileSearch(query);
    }
    return;
  }
  if (mode === "skill") {
    renderSkillList();
    return;
  }
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  runFileSearch(query);
};

export const closeMentionPopup = (): void => {
  if (!isOpen) return;
  isOpen = false;
  activeQuery = "";
  triggerStart = -1;
  searchSeq += 1;
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  $("mentionPopup").hidden = true;
  $("mentionList").innerHTML = "";
  $("mentionPopupTitle").textContent = "";
  $("mentionPopupMeta").textContent = "";
};

/** 光标前的 `@` / `#` 触发词变化时同步弹层（无触发词即关闭）。 */
const syncTriggerFromInput = (): void => {
  const input = $<HTMLTextAreaElement>("input");
  if (input.hidden || document.activeElement !== input) {
    closeMentionPopup();
    return;
  }
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const match = TRIGGER_PATTERN.exec(before);
  if (!match) {
    closeMentionPopup();
    return;
  }
  const nextMode: MentionMode = match[1] === "#" ? "skill" : "file";
  const query = match[2];
  applyQuery(nextMode, query, caret - query.length - 1);
};

// ── 选择 / 发送 ──────────────────────────────────────────────────────────

const chooseFile = (item: MentionFileItem): void => {
  const tag = `@@${item.isDirectory ? "dir" : "file"}:${item.path}@@`;
  if (
    !addReference({
      kind: item.isDirectory ? "dir" : "file",
      path: item.path,
      name: item.name,
      label: item.relativePath || item.name,
      tag,
    })
  ) {
    return;
  }
  const input = $<HTMLTextAreaElement>("input");
  input.focus();
  stripTrigger();
  closeMentionPopup();
};

const chooseSkill = (skill: SnowRemoteSkill): void => {
  const tag = `@@skill:${JSON.stringify({
    skillId: skill.id,
    name: skill.name || skill.id,
    description: skill.description || "",
    location: skill.location,
  })}@@`;
  if (
    !addReference({
      kind: "skill",
      skillId: skill.id,
      name: skill.name || skill.id,
      label: skill.name || skill.id,
      tag,
    })
  ) {
    return;
  }
  const input = $<HTMLTextAreaElement>("input");
  input.focus();
  stripTrigger();
  closeMentionPopup();
};

/** 发送时附加的引用标签（每行一个，与正文一起交给桌面端解析）。 */
export const mentionTags = (): string =>
  references.map((reference) => reference.tag).join("\n");

export const hasMentionReferences = (): boolean => references.length > 0;

/** 工作区切换时同步搜索根；弹层开着则立即按新根重查。 */
export const setMentionWorkspace = (directoryId: string): void => {
  const next = directoryId || "";
  if (next === workspaceDirectoryId) return;
  workspaceDirectoryId = next;
  if (isOpen && mode === "file") runFileSearch(activeQuery);
};

export const clearMentions = (): void => {
  references = [];
  renderReferences();
  closeMentionPopup();
};

/** 切换工作区 / 新会话时丢弃引用，并让技能列表随项目重新加载。 */
export const resetMentionContext = (): void => {
  clearMentions();
  skills = [];
  skillsLoadedAt = 0;
};

const fileReferenceFromTag = (
  kind: string,
  value: string,
): FileReference | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const isDirectory = kind === "dir";
  let path = trimmed;
  let suffix = "";
  if (!isDirectory) {
    const separator = trimmed.lastIndexOf(":");
    if (separator > 0) {
      const candidate = trimmed.slice(separator + 1);
      if (LINE_SUFFIX_PATTERN.test(candidate)) {
        path = trimmed.slice(0, separator);
        suffix = candidate;
      }
    }
  }
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
  return {
    kind: isDirectory ? "dir" : "file",
    path,
    name,
    label: suffix ? `${name}:${suffix}` : name,
    tag: `@@${isDirectory ? "dir" : "file"}:${trimmed}@@`,
  };
};

const skillReferenceFromTag = (value: string): SkillReference | null => {
  try {
    const data = JSON.parse(value) as {
      skillId?: unknown;
      name?: unknown;
      location?: unknown;
      description?: unknown;
    };
    const skillId = typeof data.skillId === "string" ? data.skillId : "";
    if (!skillId) return null;
    const name = (typeof data.name === "string" && data.name) || skillId;
    return {
      kind: "skill",
      skillId,
      name,
      label: name,
      tag: `@@skill:${JSON.stringify({
        skillId,
        name,
        description:
          typeof data.description === "string" ? data.description : "",
        location: typeof data.location === "string" ? data.location : "project",
      })}@@`,
    };
  } catch {
    return null;
  }
};

/**
 * 把文本里的引用标签还原成 chip（撤回待发送消息场景），返回清理后的正文：
 * 超出容量或解析失败的标签原样保留，避免静默丢内容。
 */
export const restoreReferencesFromText = (text: string): string => {
  let restored = false;
  const take = (
    reference: MentionReference | null,
    original: string,
  ): string => {
    if (!reference) return original;
    if (
      references.length >= MAX_REFERENCES ||
      references.some((item) => item.tag === reference.tag)
    ) {
      return original;
    }
    references.push(reference);
    restored = true;
    return "";
  };

  let cleaned = text.replace(
    FILE_TAG_PATTERN,
    (match, kind: string, value: string) =>
      take(fileReferenceFromTag(kind, value), match),
  );
  cleaned = cleaned.replace(SKILL_TAG_PATTERN, (match, value: string) =>
    take(skillReferenceFromTag(value), match),
  );
  if (restored) {
    renderReferences();
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  }
  return cleaned;
};

// ── 装配 ──────────────────────────────────────────────────────────────────

export const initMentions = (): void => {
  const input = $<HTMLTextAreaElement>("input");

  input.addEventListener("input", (event) => {
    // 输入法合成过程不触发搜索，避免拼音串被当作查询词。
    if ((event as InputEvent).isComposing) return;
    syncTriggerFromInput();
  });
  input.addEventListener("click", syncTriggerFromInput);
  input.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      closeMentionPopup();
      return;
    }
    syncTriggerFromInput();
  });

  $("mentionList").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const fileButton = target.closest<HTMLElement>("[data-mention-file]");
    if (fileButton) {
      const item = fileItems[Number(fileButton.dataset.mentionFile)];
      if (item) chooseFile(item);
      return;
    }
    const skillButton = target.closest<HTMLElement>("[data-mention-skill]");
    if (skillButton) {
      const index = Number(skillButton.dataset.mentionSkill);
      const skill = Number.isInteger(index) ? matchedSkills[index] : undefined;
      if (skill) chooseSkill(skill);
    }
  });

  $("referenceStrip").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-remove-reference]",
    );
    if (!button) return;
    const index = Number(button.dataset.removeReference);
    if (!Number.isInteger(index) || index < 0 || index >= references.length) {
      return;
    }
    references.splice(index, 1);
    renderReferences();
  });

  // 点输入区 / 弹层之外的区域时收起弹层（在捕获阶段处理，避免被其他浮层吞掉）。
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!isOpen) return;
      const target = event.target as HTMLElement;
      if (target.closest("#mentionPopup") || target.closest("#composerRow")) {
        return;
      }
      closeMentionPopup();
    },
    true,
  );

  renderReferences();
};
