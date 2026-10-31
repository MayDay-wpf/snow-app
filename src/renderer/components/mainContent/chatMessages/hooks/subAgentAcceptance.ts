/**
 * 子代理验收清单与证据回执：主控派发任务时可附带可选的验收项，子代理在
 * 最终回复里按项声明状态并引用真实工具调用产生的证据 id；宿主在收尾时
 * 校验证据 id 是否来自该子代理会话的工具执行日志，缺少有效证据的
 * `completed` 一律降级为 `unverified`。
 *
 * 约定：
 * - 清单与证据日志是「本次应用运行期」的运行时状态，按子代理会话 id 注册；
 *   重启后仅从宿主已验证的持久回执恢复；旧历史无回执时不补造证据。
 * - 证据 id 由宿主分配（ev- 前缀唯一 id）并写进子代理看到的工具结果；子代理只能引用
 *   它实际看到的 id。主控拿到的回执只带精简预览，不复制完整工具结果。
 * - 未附带清单的任务完全保持原有行为（无证据标记、无回执字段）。
 */

const SUB_AGENT_ACCEPTANCE_STATUSES = [
  "completed",
  "incomplete",
  "blocked",
  "unverified",
] as const;

import type {
  SubAgentAcceptanceStatus,
  SubAgentAcceptanceCriterion,
  SubAgentAcceptanceReasonCode,
  SubAgentAcceptanceEvidenceStatus,
  SubAgentAcceptanceEvidenceRef,
  SubAgentAcceptanceItemReceipt,
  SubAgentAcceptanceReportState,
  SubAgentAcceptanceSnapshot,
} from "../../../../../shared/subAgentRuns";
export type {
  SubAgentAcceptanceStatus,
  SubAgentAcceptanceCriterion,
  SubAgentAcceptanceReasonCode,
  SubAgentAcceptanceEvidenceStatus,
  SubAgentAcceptanceEvidenceRef,
  SubAgentAcceptanceItemReceipt,
  SubAgentAcceptanceReportState,
  SubAgentAcceptanceSnapshot,
} from "../../../../../shared/subAgentRuns";

const MAX_ACCEPTANCE_ITEMS = 20;
const MAX_ACCEPTANCE_ID_LENGTH = 64;
const MAX_ACCEPTANCE_DESCRIPTION_LENGTH = 300;
const MAX_OBSERVATION_LENGTH = 400;
const MAX_REASON_LENGTH = 400;
const MAX_EVIDENCE_PER_ITEM = 5;
const MAX_EVIDENCE_RECORDS = 500;
const EVIDENCE_PREVIEW_LENGTH = 240;
const ACCEPTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeText = (value: unknown, maxLength: number): string =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const readAcceptanceStatus = (value: unknown): SubAgentAcceptanceStatus =>
  typeof value === "string" &&
  (SUB_AGENT_ACCEPTANCE_STATUSES as readonly string[]).includes(value)
    ? (value as SubAgentAcceptanceStatus)
    : "unverified";

const readEvidenceStatus = (
  value: unknown,
): SubAgentAcceptanceEvidenceStatus =>
  value === "error" || value === "rejected" ? value : "completed";

type ParsedAcceptanceReportItem = {
  id: string;
  status: SubAgentAcceptanceStatus;
  observation: string;
  reason: string;
  evidenceIds: string[];
};

type AcceptanceItemState = {
  status: SubAgentAcceptanceStatus;
  observation: string;
  reason: string;
  reasonCode: SubAgentAcceptanceReasonCode | null;
  /**
   * 回执确认时固化的证据引用（不依赖证据日志的后续淘汰）：日志只用于
   * 校验新引用，已采信的证据不会因为日志裁剪而失效。
   */
  evidenceRefs: SubAgentAcceptanceEvidenceRef[];
  invalidEvidenceIds: string[];
  confirmedInLatestReport: boolean;
  updatedAt: number;
};

type AcceptanceTracker = {
  criteria: SubAgentAcceptanceCriterion[];
  items: Map<string, AcceptanceItemState>;
  evidence: Map<string, SubAgentAcceptanceEvidenceRef>;
  reportState: SubAgentAcceptanceReportState;
  ignoredReportIds: string[];
  updatedAt: number | null;
};

const trackers = new Map<string, AcceptanceTracker>();

const createItemState = (): AcceptanceItemState => ({
  status: "unverified",
  observation: "",
  reason: "",
  reasonCode: null,
  evidenceRefs: [],
  invalidEvidenceIds: [],
  confirmedInLatestReport: false,
  updatedAt: 0,
});

/** 解析 sub-agents-activate / sub-agents-continue 的 acceptance 参数。 */
export const parseSubAgentAcceptanceCriteria = (
  raw: unknown,
): { criteria: SubAgentAcceptanceCriterion[]; errors: string[] } => {
  if (raw === undefined || raw === null) {
    return { criteria: [], errors: [] };
  }
  if (!Array.isArray(raw)) {
    return { criteria: [], errors: ["acceptance must be an array"] };
  }
  if (raw.length > MAX_ACCEPTANCE_ITEMS) {
    return {
      criteria: [],
      errors: [`acceptance supports at most ${MAX_ACCEPTANCE_ITEMS} items`],
    };
  }

  const criteria: SubAgentAcceptanceCriterion[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`acceptance[${index}] must be an object`);
      return;
    }
    const id = normalizeText(entry.id, MAX_ACCEPTANCE_ID_LENGTH);
    const description = normalizeText(
      entry.description,
      MAX_ACCEPTANCE_DESCRIPTION_LENGTH,
    );
    if (!id || !ACCEPTANCE_ID_PATTERN.test(id)) {
      errors.push(
        `acceptance[${index}].id must be a short id using letters, digits, ".", "_", ":" or "-"`,
      );
      return;
    }
    if (!description) {
      errors.push(`acceptance[${index}].description is required`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`duplicate acceptance id: ${id}`);
      return;
    }
    seen.add(id);
    criteria.push({ id, description, required: entry.required !== false });
  });

  return { criteria, errors };
};

/** 激活时注册清单；未附带清单时不创建追踪器（保持原有行为）。 */
export const initializeSubAgentAcceptance = (
  conversationId: string,
  criteria: SubAgentAcceptanceCriterion[],
): void => {
  if (!conversationId) return;
  if (!criteria.length) {
    trackers.delete(conversationId);
    return;
  }
  const tracker: AcceptanceTracker = {
    criteria: criteria.map((criterion) => ({ ...criterion })),
    items: new Map(),
    evidence: new Map(),
    reportState: "none",
    ignoredReportIds: [],
    updatedAt: null,
  };
  for (const criterion of tracker.criteria) {
    tracker.items.set(criterion.id, createItemState());
  }
  trackers.set(conversationId, tracker);
};

/** continue 时追加清单项或修正已有项描述；已记录的状态保持不变。 */
export const mergeSubAgentAcceptanceCriteria = (
  conversationId: string,
  criteria: SubAgentAcceptanceCriterion[],
): string[] => {
  if (!conversationId || !criteria.length) return [];
  const existingTracker = trackers.get(conversationId);
  if (!existingTracker) {
    initializeSubAgentAcceptance(conversationId, criteria);
    return [];
  }

  const knownIds = new Set(
    existingTracker.criteria.map((criterion) => criterion.id),
  );
  const added = criteria.filter((criterion) => !knownIds.has(criterion.id));
  if (existingTracker.criteria.length + added.length > MAX_ACCEPTANCE_ITEMS) {
    return [`acceptance supports at most ${MAX_ACCEPTANCE_ITEMS} items`];
  }

  for (const criterion of criteria) {
    const existing = existingTracker.criteria.find(
      (item) => item.id === criterion.id,
    );
    if (existing) {
      existing.description = criterion.description;
      existing.required = criterion.required;
      continue;
    }
    existingTracker.criteria.push({ ...criterion });
    existingTracker.items.set(criterion.id, createItemState());
  }
  return [];
};

const normalizeEvidencePreview = (result: string): string =>
  result
    // 截图/图片工具结果里的图片标签（base64 或落盘路径）不进入回执预览。
    .replace(/@@image:[^@]*@@/g, "[image]")
    .replace(/[A-Za-z0-9+/=]{200,}/g, "[data]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EVIDENCE_PREVIEW_LENGTH);

/**
 * 记录一次工具执行证据并返回证据 id；未附带清单时返回 null。
 * 证据预览只截取工具结果开头，供回执回看，不复制完整结果。
 */
export const recordSubAgentEvidence = (
  conversationId: string,
  input: {
    toolName: string;
    callId: string;
    status: SubAgentAcceptanceEvidenceStatus;
    result: string;
  },
): string | null => {
  const tracker = trackers.get(conversationId);
  if (!tracker || tracker.criteria.length === 0) return null;

  // Evidence IDs must not be reused after restoring only referenced receipts.
  const id = `ev-${crypto.randomUUID()}`;
  tracker.evidence.set(id, {
    id,
    toolName: input.toolName,
    callId: input.callId,
    status: input.status,
    preview: normalizeEvidencePreview(input.result),
  });

  while (tracker.evidence.size > MAX_EVIDENCE_RECORDS) {
    const oldest = tracker.evidence.keys().next().value;
    if (typeof oldest !== "string") break;
    tracker.evidence.delete(oldest);
  }
  return id;
};

const ACCEPTANCE_BLOCK_SOURCE =
  "```acceptance[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)```";

type SubAgentAcceptanceReportParse = {
  report: ParsedAcceptanceReportItem[] | null;
  stripped: string;
  invalid: boolean;
};

/** 从最终回复中提取最后一个 acceptance 代码块（并把它从摘要里移除）。 */
export const parseSubAgentAcceptanceReport = (
  content: string,
): SubAgentAcceptanceReportParse => {
  if (!content.trim()) {
    return { report: null, stripped: content, invalid: false };
  }

  const pattern = new RegExp(ACCEPTANCE_BLOCK_SOURCE, "gi");
  let lastMatch: RegExpExecArray | null = null;
  for (
    let match = pattern.exec(content);
    match;
    match = pattern.exec(content)
  ) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return { report: null, stripped: content, invalid: false };
  }

  const stripped = `${content.slice(0, lastMatch.index)}${content.slice(
    lastMatch.index + lastMatch[0].length,
  )}`.trim();

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(lastMatch[1]);
  } catch {
    return { report: null, stripped, invalid: true };
  }
  if (!isRecord(parsedValue) || !Array.isArray(parsedValue.items)) {
    return { report: null, stripped, invalid: true };
  }

  const report: ParsedAcceptanceReportItem[] = [];
  for (const rawItem of parsedValue.items) {
    if (!isRecord(rawItem)) continue;
    const id = normalizeText(rawItem.id, MAX_ACCEPTANCE_ID_LENGTH);
    if (!id) continue;
    const rawEvidence = rawItem.evidence;
    const evidenceIds: string[] = [];
    if (typeof rawEvidence === "string") {
      evidenceIds.push(rawEvidence.trim());
    } else if (Array.isArray(rawEvidence)) {
      for (const value of rawEvidence) {
        if (typeof value === "string") evidenceIds.push(value.trim());
      }
    }
    report.push({
      id,
      status: readAcceptanceStatus(
        typeof rawItem.status === "string"
          ? rawItem.status.trim().toLowerCase()
          : "",
      ),
      observation: normalizeText(rawItem.observation, MAX_OBSERVATION_LENGTH),
      reason: normalizeText(rawItem.reason, MAX_REASON_LENGTH),
      evidenceIds: [...new Set(evidenceIds.filter(Boolean))].slice(
        0,
        MAX_EVIDENCE_PER_ITEM,
      ),
    });
  }

  if (!report.length) {
    return { report: null, stripped, invalid: true };
  }
  return { report, stripped, invalid: false };
};

const buildSnapshot = (
  tracker: AcceptanceTracker,
): SubAgentAcceptanceSnapshot => {
  const items: SubAgentAcceptanceItemReceipt[] = tracker.criteria.map(
    (criterion) => {
      const item = tracker.items.get(criterion.id) ?? createItemState();
      const evidence = item.evidenceRefs.map((record) => ({ ...record }));
      return {
        id: criterion.id,
        description: criterion.description,
        required: criterion.required,
        status: item.status,
        observation: item.observation,
        reason: item.reason,
        // 从未提交过该项目的回执：明确标记为「未报告」，而不是静默当作通过。
        reasonCode:
          item.reasonCode ?? (item.updatedAt === 0 ? "not_reported" : null),
        evidence,
        invalidEvidenceIds: [...item.invalidEvidenceIds],
        confirmedInLatestReport: item.confirmedInLatestReport,
        updatedAt: item.updatedAt,
      };
    },
  );

  const counts: SubAgentAcceptanceSnapshot["counts"] = {
    total: items.length,
    completed: 0,
    incomplete: 0,
    blocked: 0,
    unverified: 0,
  };
  for (const item of items) counts[item.status] += 1;

  return {
    items,
    counts,
    satisfied: items.every(
      (item) =>
        !item.required ||
        (item.status === "completed" && item.evidence.length > 0),
    ),
    reportState: tracker.reportState,
    ignoredReportIds: [...tracker.ignoredReportIds],
    updatedAt: tracker.updatedAt,
  };
};

/**
 * 应用一轮回执：只更新回执里出现的项；未出现的项保留之前记录的状态
 * （continue 补测时不必重复已完成步骤）。`completed` 缺少有效证据时
 * 强制降级为 `unverified`。
 */
export const applySubAgentAcceptanceReport = (
  conversationId: string,
  report: ParsedAcceptanceReportItem[],
): SubAgentAcceptanceSnapshot | null => {
  const tracker = trackers.get(conversationId);
  if (!tracker) return null;

  const reported = new Map(report.map((item) => [item.id, item]));
  const knownIds = new Set(tracker.criteria.map((criterion) => criterion.id));
  tracker.ignoredReportIds = [...reported.keys()].filter(
    (id) => !knownIds.has(id),
  );

  const now = Date.now();
  for (const criterion of tracker.criteria) {
    const item = tracker.items.get(criterion.id);
    if (!item) continue;
    const reportedItem = reported.get(criterion.id);
    item.confirmedInLatestReport = Boolean(reportedItem);
    if (!reportedItem) continue;

    const resolvedEvidence = reportedItem.evidenceIds
      .map((id) => tracker.evidence.get(id))
      .filter((record): record is SubAgentAcceptanceEvidenceRef =>
        Boolean(record),
      );
    const invalidEvidenceIds = reportedItem.evidenceIds.filter(
      (id) => !tracker.evidence.has(id),
    );

    let status = reportedItem.status;
    let reasonCode: SubAgentAcceptanceReasonCode | null = null;
    if (status === "completed" && resolvedEvidence.length === 0) {
      status = "unverified";
      reasonCode = "no_valid_evidence";
    }

    item.status = status;
    item.observation = reportedItem.observation;
    item.reason = reportedItem.reason;
    item.reasonCode = reasonCode;
    item.evidenceRefs = resolvedEvidence
      .slice(0, MAX_EVIDENCE_PER_ITEM)
      .map((record) => ({ ...record }));
    item.invalidEvidenceIds = invalidEvidenceIds;
    item.updatedAt = now;
  }

  tracker.reportState = "received";
  tracker.updatedAt = now;
  return buildSnapshot(tracker);
};

/** 本轮没有可解析的回执：所有项标记为「本轮未确认」，保留既有状态。 */
export const noteSubAgentAcceptanceReportMissing = (
  conversationId: string,
  invalid: boolean,
): SubAgentAcceptanceSnapshot | null => {
  const tracker = trackers.get(conversationId);
  if (!tracker) return null;
  for (const item of tracker.items.values()) {
    item.confirmedInLatestReport = false;
  }
  tracker.reportState = invalid ? "invalid" : "none";
  return buildSnapshot(tracker);
};

export const hasSubAgentAcceptance = (conversationId: string): boolean =>
  (trackers.get(conversationId)?.criteria.length ?? 0) > 0;

/** 只读取已存在的清单（不会为历史记录新建），用于列表与卡片展示。 */
export const peekSubAgentAcceptanceSnapshot = (
  conversationId: string,
): SubAgentAcceptanceSnapshot | null => {
  const tracker = trackers.get(conversationId);
  if (!tracker || tracker.criteria.length === 0) return null;
  return buildSnapshot(tracker);
};

/**
 * 子代理系统提示词中的验收协议：告知清单、证据 id 来源与回执格式。
 * 清单会随 continue 追加项而变化，因此每次请求前重新生成。
 */
export const buildSubAgentAcceptancePrompt = (
  conversationId: string,
): string => {
  const tracker = trackers.get(conversationId);
  if (!tracker || tracker.criteria.length === 0) return "";

  const checklist = tracker.criteria
    .map((criterion) => {
      const item = tracker.items.get(criterion.id);
      const current =
        item && item.confirmedInLatestReport
          ? ` (current status: ${item.status})`
          : "";
      return `- [${criterion.required ? "required" : "optional"}] \`${
        criterion.id
      }\`${current}: ${criterion.description}`;
    })
    .join("\n");

  return `## Acceptance Checklist (from the main agent)

The main agent attached an acceptance checklist to this task. Report every item honestly; the host validates the cited evidence against the real tool execution log. A claim without evidence is not proof.

Evidence ids: each tool result you receive starts with a line like \`[evidence ev-12]\`. Cite only ids you actually saw in THIS conversation. Never invent ids. Do not repeat side-effecting actions just to generate evidence - cite the existing execution record instead.

When you finish, end your final answer with exactly one fenced JSON block tagged \`acceptance\`:

\`\`\`acceptance
{"items":[{"id":"<checklist id>","status":"completed|incomplete|blocked|unverified","observation":"what you actually observed","evidence":["ev-3"],"reason":"only for incomplete/blocked/unverified"}],"note":"optional"}
\`\`\`

Rules:
- Use the exact checklist id and report EVERY item, including incomplete, blocked or unverifiable ones.
- \`completed\` requires at least one valid evidence id. The host downgrades \`completed\` without valid evidence to \`unverified\`.
- An item you do not report stays \`unverified\`; it is never treated as passed.
- Keep \`observation\` short and concrete: what the tool result or page actually showed.

Checklist:
${checklist}`;
};

/** 校验并规范化工具回执里的 acceptance 快照（UI 解析用）。 */
export const parseSubAgentAcceptanceSnapshot = (
  raw: unknown,
): SubAgentAcceptanceSnapshot | null => {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null;

  const items: SubAgentAcceptanceItemReceipt[] = [];
  for (const entry of raw.items) {
    if (!isRecord(entry)) continue;
    const id = normalizeText(entry.id, MAX_ACCEPTANCE_ID_LENGTH);
    if (!id) continue;

    const evidence: SubAgentAcceptanceEvidenceRef[] = [];
    if (Array.isArray(entry.evidence)) {
      for (const ref of entry.evidence) {
        if (!isRecord(ref)) continue;
        const evidenceId = normalizeText(ref.id, MAX_ACCEPTANCE_ID_LENGTH);
        if (!evidenceId) continue;
        evidence.push({
          id: evidenceId,
          toolName: normalizeText(ref.toolName, MAX_ACCEPTANCE_ID_LENGTH),
          callId: normalizeText(ref.callId, MAX_ACCEPTANCE_ID_LENGTH),
          status: readEvidenceStatus(ref.status),
          preview: normalizeText(ref.preview, EVIDENCE_PREVIEW_LENGTH),
        });
      }
    }

    const invalidEvidenceIds = Array.isArray(entry.invalidEvidenceIds)
      ? entry.invalidEvidenceIds
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, MAX_EVIDENCE_PER_ITEM)
      : [];

    items.push({
      id,
      description: normalizeText(
        entry.description,
        MAX_ACCEPTANCE_DESCRIPTION_LENGTH,
      ),
      required: entry.required !== false,
      status: readAcceptanceStatus(entry.status),
      observation: normalizeText(entry.observation, MAX_OBSERVATION_LENGTH),
      reason: normalizeText(entry.reason, MAX_REASON_LENGTH),
      reasonCode:
        entry.reasonCode === "not_reported" ||
        entry.reasonCode === "no_valid_evidence"
          ? entry.reasonCode
          : null,
      evidence,
      invalidEvidenceIds,
      confirmedInLatestReport: entry.confirmedInLatestReport === true,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
    });
  }

  if (!items.length) return null;

  const counts: SubAgentAcceptanceSnapshot["counts"] = {
    total: items.length,
    completed: 0,
    incomplete: 0,
    blocked: 0,
    unverified: 0,
  };
  for (const item of items) counts[item.status] += 1;

  return {
    items,
    counts,
    satisfied: raw.satisfied === true,
    reportState:
      raw.reportState === "received" || raw.reportState === "invalid"
        ? raw.reportState
        : "none",
    ignoredReportIds: Array.isArray(raw.ignoredReportIds)
      ? raw.ignoredReportIds
          .filter((value): value is string => typeof value === "string")
          .slice(0, MAX_ACCEPTANCE_ITEMS)
      : [],
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : null,
  };
};

/** Restore only a host-validated durable receipt, never a model's self-report. */
export const restoreSubAgentAcceptanceSnapshot = (
  conversationId: string,
  snapshot: SubAgentAcceptanceSnapshot,
): void => {
  if (trackers.has(conversationId)) return;
  const tracker: AcceptanceTracker = {
    criteria: snapshot.items.map(({ id, description, required }) => ({
      id,
      description,
      required,
    })),
    items: new Map(),
    evidence: new Map(),
    reportState: snapshot.reportState,
    ignoredReportIds: [...snapshot.ignoredReportIds],
    updatedAt: snapshot.updatedAt,
  };
  for (const item of snapshot.items) {
    tracker.items.set(item.id, {
      status: item.status,
      observation: item.observation,
      reason: item.reason,
      reasonCode: item.reasonCode,
      evidenceRefs: item.evidence.map((evidence) => ({ ...evidence })),
      invalidEvidenceIds: [...item.invalidEvidenceIds],
      confirmedInLatestReport: item.confirmedInLatestReport,
      updatedAt: item.updatedAt,
    });
    for (const evidence of item.evidence) {
      tracker.evidence.set(evidence.id, { ...evidence });
    }
  }
  trackers.set(conversationId, tracker);
};

/** Merge a durable host receipt when its message is actually consumed by its run. */
export const mergeSubAgentAcceptanceSnapshot = (
  conversationId: string,
  snapshot: SubAgentAcceptanceSnapshot,
): void => {
  const tracker = trackers.get(conversationId);
  if (!tracker) {
    restoreSubAgentAcceptanceSnapshot(conversationId, snapshot);
    return;
  }
  const knownIds = new Set(tracker.criteria.map((criterion) => criterion.id));
  const errors = mergeSubAgentAcceptanceCriteria(
    conversationId,
    snapshot.items
      .filter((item) => !knownIds.has(item.id))
      .map(({ id, description, required }) => ({ id, description, required })),
  );
  if (errors.length) throw new Error(`VALIDATION_ERROR: ${errors.join("; ")}`);
  for (const item of snapshot.items) {
    const current = tracker.items.get(item.id);
    if (!current || item.updatedAt > current.updatedAt) {
      tracker.items.set(item.id, {
        status: item.status,
        observation: item.observation,
        reason: item.reason,
        reasonCode: item.reasonCode,
        evidenceRefs: item.evidence.map((evidence) => ({ ...evidence })),
        invalidEvidenceIds: [...item.invalidEvidenceIds],
        confirmedInLatestReport: item.confirmedInLatestReport,
        updatedAt: item.updatedAt,
      });
    }
    for (const evidence of item.evidence)
      tracker.evidence.set(evidence.id, { ...evidence });
  }
  if (
    snapshot.updatedAt !== null &&
    (tracker.updatedAt === null || snapshot.updatedAt > tracker.updatedAt)
  ) {
    tracker.updatedAt = snapshot.updatedAt;
    tracker.reportState = snapshot.reportState;
  }
  tracker.ignoredReportIds = Array.from(
    new Set([...tracker.ignoredReportIds, ...snapshot.ignoredReportIds]),
  );
};
