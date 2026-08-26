import {
  AlertCircle,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileCode2,
  FolderKanban,
  Globe,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  RotateCw,
  SkipForward,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { useScheduledTasks } from "../../hooks/useScheduledTasks";
import { validateSchedule } from "../../hooks/scheduledTasksStore";
import type {
  ApiConfigRecord,
  Model,
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  ScheduledTaskSchedule,
  ScheduledTaskType,
} from "../../../preload";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { THINKING_OPTIONS_BY_METHOD } from "../mainContent/chatInput/constants";
import {
  createChipHtml,
  createImageChipHtml,
  createSkillChipHtml,
  insertHtmlAtSelection,
  isEditableContentEmpty,
  readEditableContent,
  renumberImageChips,
  type FileTag,
  type ImageTag,
  type SkillTag,
} from "../mainContent/chatInput/fileTagUtils";
import {
  FileMentionPopup,
  type FileMentionPopupHandle,
} from "../mainContent/chatInput/FileMentionPopup";
import { ThinkingStrengthMenu } from "../mainContent/chatInput/ThinkingStrengthMenu";
import {
  getThinkingValueFromConfig,
  normalizeRequestMethod,
} from "../mainContent/chatInput/configThinking";
import { ApiModelCombobox } from "./apiSettings/ApiModelCombobox";

type RecurringMode = "interval" | "daily";
type TaskFilter = "all" | "project" | "global";
type TaskPanelMode = "details" | "create";
type TaskStatusKey = "pending" | "running" | "completed" | "error" | "paused";

type Translate = (
  key: string,
  options?: {
    defaultValue?: string;
    values?: Record<string, string | number>;
  },
) => string;

type ScheduledTasksModalProps = {
  open: boolean;
  directoryId: string;
  directoryPath: string;
  onClose: () => void;
};

const PREVIEW_MAX_LEN = 160;

const previewPrompt = (prompt: string): string => {
  const plain = prompt.replace(/\s+/g, " ").trim();
  if (plain.length <= PREVIEW_MAX_LEN) return plain;
  return `${plain.slice(0, PREVIEW_MAX_LEN)}…`;
};

/** Formats an ISO timestamp (or epoch ms) into a localized relative/absolute label. */
const formatRunTime = (iso: string | undefined): string => {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const date = new Date(ms);
  const now = Date.now();
  const diffMs = ms - now;
  const absMin = Math.abs(Math.round(diffMs / 60000));
  if (absMin < 1) return date.toLocaleTimeString();
  if (absMin < 60) {
    return diffMs >= 0 ? `in ${absMin}m` : `${absMin}m ago`;
  }
  const absHr = Math.round(absMin / 60);
  if (absHr < 24) {
    return diffMs >= 0 ? `in ${absHr}h` : `${absHr}h ago`;
  }
  return date.toLocaleString();
};

const parseTimestamp = (value: string | undefined): Date | null => {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
};

const formatAbsoluteTime = (
  value: string | undefined,
  locale: string,
): string | null => {
  const date = parseTimestamp(value);
  if (!date) return null;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const formatRelativeTime = (
  value: string | undefined,
  locale: string,
): string | null => {
  const date = parseTimestamp(value);
  if (!date) return null;

  const diffMs = date.getTime() - Date.now();
  const absoluteMs = Math.abs(diffMs);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (absoluteMs < 60_000) {
    return formatter.format(Math.round(diffMs / 1_000), "second");
  }
  if (absoluteMs < 3_600_000) {
    return formatter.format(Math.round(diffMs / 60_000), "minute");
  }
  if (absoluteMs < 86_400_000) {
    return formatter.format(Math.round(diffMs / 3_600_000), "hour");
  }
  if (absoluteMs < 7 * 86_400_000) {
    return formatter.format(Math.round(diffMs / 86_400_000), "day");
  }
  return formatAbsoluteTime(value, locale);
};

const formatDuration = (durationMs: number, locale: string): string => {
  const safeDuration = Math.max(0, durationMs);
  if (safeDuration < 1_000) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "millisecond",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(Math.max(1, Math.round(safeDuration)));
  }
  if (safeDuration < 60_000) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(safeDuration / 1_000);
  }
  if (safeDuration < 3_600_000) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "minute",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(safeDuration / 60_000);
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "hour",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(safeDuration / 3_600_000);
};

const formatSchedule = (
  schedule: ScheduledTaskSchedule,
  t: Translate,
  locale: string,
): string => {
  if (schedule.type === "once") {
    return (
      formatAbsoluteTime(schedule.executeAt, locale) ??
      t("scheduledTask.invalidSchedule", { defaultValue: "Invalid" })
    );
  }

  if (schedule.mode === "interval") {
    const interval = schedule.intervalMs ?? 0;
    const minutes = Math.round(interval / 60_000);
    if (minutes >= 60 && minutes % 60 === 0) {
      const hours = minutes / 60;
      return t("scheduledTask.everyHours", {
        values: { hours },
        defaultValue: `Every ${hours}h`,
      });
    }
    return t("scheduledTask.everyMinutes", {
      values: { minutes },
      defaultValue: `Every ${minutes}m`,
    });
  }

  const date = new Date(2000, 0, 1, schedule.hour ?? 0, schedule.minute ?? 0);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  return t("scheduledTask.dailyAt", {
    values: { time },
    defaultValue: `Daily at ${time}`,
  });
};

/**
 * 在所有请求方法的思考强度选项里查找某值的显示标签（与聊天输入区共用
 * THINKING_OPTIONS_BY_METHOD，保证文案一致）；找不到时原样返回。
 */
const findThinkingOptionLabel = (value: string): string => {
  for (const method of Object.values(THINKING_OPTIONS_BY_METHOD)) {
    const option = method.find((candidate) => candidate.value === value);
    if (option) return option.label;
  }
  return value;
};

const getTaskStatusKey = (task: ScheduledTaskRecord): TaskStatusKey => {
  if (task.paused) return "paused";
  return task.status;
};

const getTasksForFilter = (
  tasks: ScheduledTaskRecord[],
  filter: TaskFilter,
): ScheduledTaskRecord[] => {
  if (filter === "global") {
    return tasks.filter((task) => task.directoryId === "");
  }
  if (filter === "project") {
    return tasks.filter((task) => task.directoryId !== "");
  }
  return tasks;
};

const pad2 = (value: number): string => value.toString().padStart(2, "0");

const toLocalDateTimeInput = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate(),
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

export function ScheduledTasksModal({
  open,
  directoryId,
  directoryPath,
  onClose,
}: ScheduledTasksModalProps): React.JSX.Element {
  const { locale, t } = useI18n();
  const {
    tasks,
    createTask,
    updateTask,
    removeTask,
    clearTasks,
    clearGlobalTasks,
    togglePauseTask,
    runTaskNow,
    isExecutorReady,
  } = useScheduledTasks(directoryId, directoryPath);

  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<TaskPanelMode>("details");

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionPopupStyle, setMentionPopupStyle] =
    useState<React.CSSProperties>({});
  const [taskType, setTaskType] = useState<ScheduledTaskType>("once");
  const [taskScope, setTaskScope] = useState<"project" | "global">(
    directoryId ? "project" : "global",
  );
  const [recurringMode, setRecurringMode] = useState<RecurringMode>("interval");
  const [executeAtLocal, setExecuteAtLocal] = useState(() =>
    toLocalDateTimeInput(Date.now() + 60_000),
  );
  const [intervalValue, setIntervalValue] = useState("5");
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours">(
    "minutes",
  );
  const [dailyHour, setDailyHour] = useState("9");
  const [dailyMinute, setDailyMinute] = useState("0");
  // pre-script (optional)
  const [preScriptOpen, setPreScriptOpen] = useState(false);
  const [preScript, setPreScript] = useState("");
  const [preScriptTimeout, setPreScriptTimeout] = useState("60");
  const [runOnScriptError, setRunOnScriptError] = useState(false);

  const [apiConfigs, setApiConfigs] = useState<ApiConfigRecord[]>([]);
  const [selectedApiProfile, setSelectedApiProfile] = useState("");
  const [basicModelOverride, setBasicModelOverride] = useState("");
  const [advancedModelOverride, setAdvancedModelOverride] = useState("");
  const [thinkingStrength, setThinkingStrength] = useState("");
  const [isThinkingMenuOpen, setIsThinkingMenuOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<Model[]>([]);
  const [isLoadingModelOptions, setIsLoadingModelOptions] = useState(false);
  const [modelOptionsError, setModelOptionsError] = useState<string | null>(
    null,
  );
  const [loadedModelsFor, setLoadedModelsFor] = useState<string | null>(null);

  const [formError, setFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  /** 详情视图「运行配置」编辑模式：正在编辑运行配置的任务 id（null = 只读）。 */
  const [editingConfigTaskId, setEditingConfigTaskId] = useState<string | null>(
    null,
  );
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearGlobalOpen, setClearGlobalOpen] = useState(false);
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);

  const copyPromptTimerRef = useRef<number | null>(null);
  const modelRequestIdRef = useRef(0);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const promptInputRef = useRef<HTMLDivElement | null>(null);
  const mentionPopupRef = useRef<FileMentionPopupHandle>(null);
  const mentionStartOffsetRef = useRef<number>(-1);
  const promptDraggingRef = useRef(false);
  const wasOpenRef = useRef(false);
  const thinkingMenuRef = useRef<HTMLDivElement | null>(null);

  const globalTasks = useMemo(
    () => tasks.filter((task) => task.directoryId === ""),
    [tasks],
  );
  const projectTasks = useMemo(
    () => tasks.filter((task) => task.directoryId !== ""),
    [tasks],
  );
  const visibleTasks = useMemo(
    () => getTasksForFilter(tasks, filter),
    [filter, tasks],
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks],
  );
  const deleteTarget = useMemo(
    () => tasks.find((task) => task.id === deleteTargetId) ?? null,
    [deleteTargetId, tasks],
  );

  const activeConfig = useMemo(
    () => apiConfigs.find((config) => config.isActive) ?? null,
    [apiConfigs],
  );
  const selectedConfig = useMemo((): ApiConfigRecord | null => {
    if (selectedApiProfile) {
      return (
        apiConfigs.find(
          (config) => config.profileName === selectedApiProfile,
        ) ?? null
      );
    }
    return activeConfig;
  }, [activeConfig, apiConfigs, selectedApiProfile]);

  const requestMethod = normalizeRequestMethod(selectedConfig?.requestMethod);
  const thinkingOptions = THINKING_OPTIONS_BY_METHOD[requestMethod];
  const profileThinkingValue = useMemo(
    () => (selectedConfig ? getThinkingValueFromConfig(selectedConfig) : null),
    [selectedConfig],
  );
  const profileThinkingLabel = useMemo(() => {
    if (!profileThinkingValue) return null;
    return findThinkingOptionLabel(profileThinkingValue);
  }, [profileThinkingValue]);

  // "默认（继承 Profile 当前值）"选项文案，思考强度触发按钮与菜单共用
  const inheritThinkingLabel = profileThinkingLabel
    ? t("scheduledTask.defaultWithValue", {
        values: { value: profileThinkingLabel },
        defaultValue: `Default (${profileThinkingLabel})`,
      })
    : t("scheduledTask.optionDefault", {
        defaultValue: "Default",
      });

  const resetModelOptions = useCallback((): void => {
    modelRequestIdRef.current += 1;
    setModelOptions([]);
    setIsLoadingModelOptions(false);
    setModelOptionsError(null);
    setLoadedModelsFor(null);
  }, []);

  const resetFormDraft = useCallback((): void => {
    setName("");
    setPrompt("");
    const promptEditor = promptInputRef.current;
    if (promptEditor) {
      promptEditor.innerHTML = "";
      promptEditor.dataset.empty = "true";
    }
    setIsMentionOpen(false);
    setMentionQuery("");
    mentionStartOffsetRef.current = -1;
    setTaskType("once");
    setTaskScope(directoryId ? "project" : "global");
    setRecurringMode("interval");
    setExecuteAtLocal(toLocalDateTimeInput(Date.now() + 60_000));
    setIntervalValue("5");
    setIntervalUnit("minutes");
    setDailyHour("9");
    setDailyMinute("0");
    setSelectedApiProfile("");
    setBasicModelOverride("");
    setAdvancedModelOverride("");
    setThinkingStrength("");
    setFormError(null);
    resetModelOptions();
  }, [directoryId, resetModelOptions]);

  /** 退出运行配置编辑模式：清空与创建表单共用的草稿状态，避免残留。 */
  const exitEditConfig = useCallback((): void => {
    setEditingConfigTaskId(null);
    setFormError(null);
    setSelectedApiProfile("");
    setBasicModelOverride("");
    setAdvancedModelOverride("");
    setThinkingStrength("");
    resetModelOptions();
  }, [resetModelOptions]);

  /** 进入运行配置编辑模式：用任务当前的覆盖值填充草稿。 */
  const startEditConfig = useCallback(
    (task: ScheduledTaskRecord): void => {
      setSelectedApiProfile(task.apiProfile ?? "");
      setBasicModelOverride(task.basicModel ?? "");
      setAdvancedModelOverride(task.model ?? "");
      setThinkingStrength(task.thinkingStrength ?? "");
      setPreScript(task.preScript ?? "");
      setPreScriptTimeout(
        task.preScriptTimeoutMs
          ? String(Math.round(task.preScriptTimeoutMs / 1000))
          : "60",
      );
      setRunOnScriptError(task.runOnScriptError ?? false);
      setPreScriptOpen(Boolean(task.preScript));
      resetModelOptions();
      setFormError(null);
      setEditingConfigTaskId(task.id);
    },
    [resetModelOptions],
  );

  /** 保存运行配置：空字符串 = 清除覆盖（回到继承语义）。 */
  const saveEditConfig = useCallback((): void => {
    const taskId = editingConfigTaskId;
    if (!taskId) return;
    const trimmedPreScript = preScript.trim();
    const timeoutValue = Number.parseFloat(preScriptTimeout);
    if (trimmedPreScript && !Number.isFinite(timeoutValue)) {
      setFormError(
        t("scheduledTask.errorInvalidTimeout", {
          defaultValue: "Pre-script timeout must be a number",
        }),
      );
      return;
    }
    const updated = updateTask(taskId, {
      apiProfile: selectedApiProfile.trim() || undefined,
      basicModel: basicModelOverride.trim() || undefined,
      model: advancedModelOverride.trim() || undefined,
      thinkingStrength: thinkingStrength.trim() || undefined,
      preScript: trimmedPreScript || undefined,
      preScriptTimeoutMs: trimmedPreScript
        ? Math.round(timeoutValue * 1000)
        : undefined,
      runOnScriptError: trimmedPreScript ? runOnScriptError : undefined,
    });
    if (updated) {
      exitEditConfig();
    } else {
      setFormError(
        t("scheduledTask.errorSaveFailed", {
          defaultValue: "Failed to save changes",
        }),
      );
    }
  }, [
    advancedModelOverride,
    basicModelOverride,
    editingConfigTaskId,
    exitEditConfig,
    preScript,
    preScriptTimeout,
    runOnScriptError,
    selectedApiProfile,
    t,
    thinkingStrength,
    updateTask,
  ]);

  // 被编辑的任务被删除/清除时自动退出编辑模式（如删除、清空项目任务）。
  useEffect(() => {
    if (
      editingConfigTaskId !== null &&
      !tasks.some((task) => task.id === editingConfigTaskId)
    ) {
      exitEditConfig();
    }
  }, [editingConfigTaskId, exitEditConfig, tasks]);

  useEffect(() => {
    if (!directoryId && taskScope === "project") {
      setTaskScope("global");
    }
  }, [directoryId, taskScope]);

  useEffect(() => {
    if (!directoryId && filter === "project") {
      setFilter("all");
    }
  }, [directoryId, filter]);

  // 点击思考强度菜单外部时关闭
  useEffect(() => {
    if (!isThinkingMenuOpen) return;
    const handleMouseDown = (event: MouseEvent): void => {
      if (
        thinkingMenuRef.current &&
        !thinkingMenuRef.current.contains(event.target as Node)
      ) {
        setIsThinkingMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isThinkingMenuOpen]);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open || wasOpen) return;

    setFormError(null);
    const selectedIsVisible = visibleTasks.some(
      (task) => task.id === selectedTaskId,
    );
    if (visibleTasks.length > 0) {
      setSelectedTaskId(
        selectedIsVisible ? selectedTaskId : visibleTasks[0].id,
      );
      setPanelMode("details");
      return;
    }

    setSelectedTaskId(null);
    setPanelMode("create");
  }, [open, selectedTaskId, tasks.length, visibleTasks]);

  useEffect(() => {
    if (!open) return;

    if (visibleTasks.length === 0) {
      if (selectedTaskId !== null) {
        setSelectedTaskId(null);
      }
      if (tasks.length === 0 && panelMode !== "create") {
        setPanelMode("create");
      }
      return;
    }

    if (!visibleTasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(visibleTasks[0].id);
    }
  }, [open, panelMode, selectedTaskId, tasks.length, visibleTasks]);

  useEffect(() => {
    if (!open || panelMode !== "create") return;
    const frame = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, panelMode]);

  useEffect(() => {
    if (!isMentionOpen) {
      return;
    }

    const updateMentionPopupPosition = (): void => {
      const editor = promptInputRef.current;
      if (!editor) {
        return;
      }
      const rect = editor.getBoundingClientRect();
      setMentionPopupStyle({
        position: "fixed",
        left: rect.left,
        right: "auto",
        bottom: window.innerHeight - rect.top + 4,
        width: rect.width,
        marginBottom: 0,
        zIndex: 10000,
      });
    };

    updateMentionPopupPosition();
    window.addEventListener("resize", updateMentionPopupPosition);
    const scrollContainer = promptInputRef.current?.closest(
      ".scheduled-tasks-form-scroll",
    );
    scrollContainer?.addEventListener(
      "scroll",
      updateMentionPopupPosition,
      true,
    );
    return () => {
      window.removeEventListener("resize", updateMentionPopupPosition);
      scrollContainer?.removeEventListener(
        "scroll",
        updateMentionPopupPosition,
        true,
      );
    };
  }, [isMentionOpen]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.snow
      .listApiConfigs()
      .then((configs) => {
        if (!cancelled) setApiConfigs(configs);
      })
      .catch(() => {
        if (!cancelled) setApiConfigs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(
    () => () => {
      if (copyPromptTimerRef.current !== null) {
        window.clearTimeout(copyPromptTimerRef.current);
      }
      modelRequestIdRef.current += 1;
    },
    [],
  );

  const handleCopyPrompt = useCallback(
    (taskId: string, taskPrompt: string): void => {
      void navigator.clipboard?.writeText(taskPrompt).catch(() => undefined);
      setCopiedPromptId(taskId);
      if (copyPromptTimerRef.current !== null) {
        window.clearTimeout(copyPromptTimerRef.current);
      }
      copyPromptTimerRef.current = window.setTimeout(() => {
        setCopiedPromptId(null);
        copyPromptTimerRef.current = null;
      }, 1_500);
    },
    [],
  );

  const handleCloseMention = useCallback((): void => {
    setIsMentionOpen(false);
    setMentionQuery("");
    mentionStartOffsetRef.current = -1;
  }, []);

  const deleteMentionQuery = useCallback((): void => {
    const editor = promptInputRef.current;
    if (!editor || mentionStartOffsetRef.current < 0) {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) {
      return;
    }
    const textNode = range.startContainer as Text;
    const currentOffset = range.startOffset;
    const start = mentionStartOffsetRef.current - 1;
    if (start < 0 || currentOffset <= start) {
      return;
    }
    range.setStart(textNode, start);
    range.setEnd(textNode, currentOffset);
    range.deleteContents();
    selection.removeAllRanges();
    selection.addRange(range);
    mentionStartOffsetRef.current = -1;
  }, []);

  const checkPromptInputTriggers = useCallback((): void => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      handleCloseMention();
      return;
    }
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      handleCloseMention();
      return;
    }
    const offset = range.startOffset;
    const textBefore = (node.textContent ?? "").slice(0, offset);
    const mentionMatch = textBefore.match(/(?:^|\s)@([^\s]*)$/);
    if (!mentionMatch) {
      handleCloseMention();
      return;
    }
    const queryText = mentionMatch[1];
    const atOffset = offset - queryText.length - 1;
    setIsMentionOpen(true);
    setMentionQuery(queryText);
    mentionStartOffsetRef.current = atOffset + 1;
  }, [handleCloseMention]);

  const syncPromptContent = useCallback((): void => {
    const editor = promptInputRef.current;
    if (!editor) {
      return;
    }
    renumberImageChips(editor);
    const content = readEditableContent(editor);
    setPrompt(content);
    editor.dataset.empty = isEditableContentEmpty(content) ? "true" : "false";
  }, []);

  const insertPromptFileTag = useCallback(
    (tag: FileTag | SkillTag): void => {
      promptInputRef.current?.focus();
      insertHtmlAtSelection(
        "skillId" in tag ? createSkillChipHtml(tag) : createChipHtml(tag),
      );
      syncPromptContent();
    },
    [syncPromptContent],
  );

  const insertPromptImageFile = useCallback(
    (file: File): void => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        if (!dataUrl) {
          return;
        }
        const mimeMatch = file.type.match(/^image\/([a-z0-9+.-]+)$/i);
        const extension = mimeMatch ? mimeMatch[1].split("+")[0] : "png";
        const imageTag: ImageTag = {
          name: `image.${extension}`,
          dataUrl,
        };
        promptInputRef.current?.focus();
        insertHtmlAtSelection(createImageChipHtml(imageTag));
        syncPromptContent();
      };
      reader.readAsDataURL(file);
    },
    [syncPromptContent],
  );

  const handlePromptPaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const imageFiles: File[] = [];
      for (const item of event.clipboardData.items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }
      if (imageFiles.length > 0) {
        promptInputRef.current?.focus();
        imageFiles.forEach(insertPromptImageFile);
        return;
      }
      const text = event.clipboardData.getData("text/plain");
      if (!text) {
        return;
      }
      document.execCommand("insertText", false, text);
      syncPromptContent();
      checkPromptInputTriggers();
    },
    [checkPromptInputTriggers, insertPromptImageFile, syncPromptContent],
  );

  const insertPromptExternalFiles = useCallback(
    (files: File[]): void => {
      if (files.length === 0) {
        return;
      }
      void window.snow
        .resolveDroppedFiles(files)
        .then((entries) => {
          if (entries.length === 0) {
            return;
          }
          const imageFiles: File[] = [];
          const fileTags: FileTag[] = [];
          entries.forEach((entry, index) => {
            const matchedFile = files[index];
            const isImage =
              !entry.isDirectory &&
              ((matchedFile?.type.startsWith("image/") ?? false) ||
                /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(entry.path));
            if (isImage && matchedFile) {
              imageFiles.push(matchedFile);
              return;
            }
            const name =
              entry.path.split(/[\\/]/).filter(Boolean).pop() || entry.path;
            fileTags.push({
              path: entry.path,
              name,
              isDirectory: entry.isDirectory,
            });
          });
          imageFiles.forEach(insertPromptImageFile);
          fileTags.forEach(insertPromptFileTag);
        })
        .catch(() => {
          // 解析失败时静默处理
        });
    },
    [insertPromptFileTag, insertPromptImageFile],
  );

  const handlePromptDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      promptDraggingRef.current = false;
      promptInputRef.current?.classList.remove("drag-over");

      const droppedFiles = Array.from(event.dataTransfer.files);
      if (droppedFiles.length > 0) {
        insertPromptExternalFiles(droppedFiles);
        return;
      }

      const jsonData = event.dataTransfer.getData("application/json");
      if (jsonData) {
        try {
          const parsed = JSON.parse(jsonData) as Record<string, unknown>;
          const createFileTag = (value: unknown): FileTag | null => {
            if (!value || typeof value !== "object") {
              return null;
            }
            const raw = value as Record<string, unknown>;
            if (typeof raw.path !== "string" || typeof raw.name !== "string") {
              return null;
            }
            const rawLines = raw.lines;
            const lines = Array.isArray(rawLines)
              ? rawLines
                  .map((line) =>
                    typeof line === "number"
                      ? line
                      : Number.parseInt(String(line), 10),
                  )
                  .filter((line) => Number.isFinite(line) && line > 0)
              : undefined;
            return {
              path: raw.path,
              name: raw.name,
              isDirectory: raw.isDirectory === true,
              lines: raw.isDirectory === true ? undefined : lines,
            };
          };

          if (parsed.type === "file-tags" && Array.isArray(parsed.tags)) {
            const tags = parsed.tags
              .map(createFileTag)
              .filter((tag): tag is FileTag => tag !== null);
            tags.forEach(insertPromptFileTag);
          } else {
            const tag = createFileTag(parsed);
            if (tag) {
              insertPromptFileTag(tag);
            }
          }
        } catch {
          // 忽略无效拖拽数据
        }
        return;
      }

      const plainText = event.dataTransfer.getData("text/plain");
      if (plainText.trim().length > 0) {
        promptInputRef.current?.focus();
        document.execCommand("insertText", false, plainText);
        syncPromptContent();
      }
    },
    [insertPromptExternalFiles, insertPromptFileTag, syncPromptContent],
  );

  const handlePromptDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      const types = event.dataTransfer.types;
      const allowed =
        types.includes("application/json") ||
        types.includes("Files") ||
        types.includes("text/plain");
      if (!allowed) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!promptDraggingRef.current) {
        promptDraggingRef.current = true;
        promptInputRef.current?.classList.add("drag-over");
      }
    },
    [],
  );

  const handlePromptDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (event.currentTarget !== event.target) {
        return;
      }
      promptDraggingRef.current = false;
      promptInputRef.current?.classList.remove("drag-over");
    },
    [],
  );

  const handleMentionSelect = useCallback(
    (tag: FileTag | SkillTag): void => {
      deleteMentionQuery();
      insertPromptFileTag(tag);
    },
    [deleteMentionQuery, insertPromptFileTag],
  );

  const handleMentionSelectBatch = useCallback(
    (tags: (FileTag | SkillTag)[]): void => {
      deleteMentionQuery();
      tags.forEach(insertPromptFileTag);
    },
    [deleteMentionQuery, insertPromptFileTag],
  );

  const replaceMentionQuery = useCallback(
    (relativePath: string): void => {
      const editor = promptInputRef.current;
      if (!editor || mentionStartOffsetRef.current < 0) {
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return;
      }
      const range = selection.getRangeAt(0);
      if (range.startContainer.nodeType !== Node.TEXT_NODE) {
        return;
      }
      const textNode = range.startContainer as Text;
      const currentOffset = range.startOffset;
      const start = mentionStartOffsetRef.current;
      if (currentOffset < start) {
        return;
      }
      range.setStart(textNode, start);
      range.setEnd(textNode, currentOffset);
      range.deleteContents();
      selection.removeAllRanges();
      selection.addRange(range);
      if (relativePath) {
        document.execCommand("insertText", false, `${relativePath}/`);
      }
      checkPromptInputTriggers();
    },
    [checkPromptInputTriggers],
  );

  const handlePromptInput = useCallback((): void => {
    syncPromptContent();
    checkPromptInputTriggers();
  }, [checkPromptInputTriggers, syncPromptContent]);

  const handlePromptKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (isMentionOpen && mentionPopupRef.current?.handleKeyDown(event)) {
        return;
      }
    },
    [isMentionOpen],
  );

  const handlePromptClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const removeButton = target.closest<HTMLElement>(
        "[data-chip-remove='true']",
      );
      if (!removeButton) {
        return;
      }
      removeButton.parentElement?.remove();
      syncPromptContent();
    },
    [syncPromptContent],
  );

  const loadModelOptions = useCallback(
    async (force = false): Promise<void> => {
      if (!selectedConfig) return;
      const cacheKey = selectedConfig.profileName;
      if (isLoadingModelOptions || (!force && loadedModelsFor === cacheKey)) {
        return;
      }

      const requestId = ++modelRequestIdRef.current;
      setIsLoadingModelOptions(true);
      setModelOptionsError(null);
      try {
        const available = await window.snow.fetchAvailableModelsForConfig({
          baseUrl: selectedConfig.baseUrl,
          baseUrlMode: selectedConfig.baseUrlMode,
          apiKey: selectedConfig.apiKey,
          requestMethod: selectedConfig.requestMethod,
          customHeaderSchemeId: selectedConfig.customHeaderSchemeId,
        });
        if (modelRequestIdRef.current !== requestId) return;
        setModelOptions(available);
        setLoadedModelsFor(cacheKey);
      } catch (error) {
        if (modelRequestIdRef.current !== requestId) return;
        setModelOptionsError(
          error instanceof Error
            ? error.message
            : t("chat.loadModelsError", {
                defaultValue: "Failed to load models",
              }),
        );
        setLoadedModelsFor(null);
      } finally {
        if (modelRequestIdRef.current === requestId) {
          setIsLoadingModelOptions(false);
        }
      }
    },
    [isLoadingModelOptions, loadedModelsFor, selectedConfig, t],
  );

  const handleApiProfileChange = useCallback(
    (profileName: string): void => {
      setSelectedApiProfile(profileName);
      setBasicModelOverride("");
      setAdvancedModelOverride("");
      setThinkingStrength("");
      resetModelOptions();
    },
    [resetModelOptions],
  );

  const buildSchedule = useCallback((): ScheduledTaskSchedule => {
    if (taskType === "once") {
      const timestamp = Date.parse(`${executeAtLocal}:00`);
      return {
        type: "once",
        executeAt: Number.isNaN(timestamp)
          ? executeAtLocal
          : new Date(timestamp).toISOString(),
      };
    }

    if (recurringMode === "interval") {
      const value = Number.parseFloat(intervalValue);
      const unitMs = intervalUnit === "hours" ? 3_600_000 : 60_000;
      return {
        type: "recurring",
        mode: "interval",
        intervalMs: Number.isFinite(value) ? value * unitMs : 0,
      };
    }

    return {
      type: "recurring",
      mode: "daily",
      hour: Number.parseInt(dailyHour, 10),
      minute: Number.parseInt(dailyMinute, 10),
    };
  }, [
    dailyHour,
    dailyMinute,
    executeAtLocal,
    intervalUnit,
    intervalValue,
    recurringMode,
    taskType,
  ]);

  const handleCreate = useCallback(async (): Promise<void> => {
    setFormError(null);
    if (taskScope === "project" && !directoryId) {
      setFormError(
        t("scheduledTask.scopeProjectDisabled", {
          defaultValue: "No active project",
        }),
      );
      return;
    }

    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) {
      setFormError(
        t("scheduledTask.errorNameRequired", {
          defaultValue: "Name is required",
        }),
      );
      return;
    }
    if (!trimmedPrompt) {
      setFormError(
        t("scheduledTask.errorPromptRequired", {
          defaultValue: "Prompt is required",
        }),
      );
      return;
    }

    const schedule = buildSchedule();
    try {
      validateSchedule(schedule);
    } catch {
      setFormError(
        t("scheduledTask.errorInvalidSchedule", {
          defaultValue: "Invalid schedule",
        }),
      );
      return;
    }

    const trimmedPreScript = preScript.trim();
    const timeoutValue = Number.parseFloat(preScriptTimeout);
    if (trimmedPreScript && !Number.isFinite(timeoutValue)) {
      setFormError(
        t("scheduledTask.errorInvalidTimeout", {
          defaultValue: "Pre-script timeout must be a number",
        }),
      );
      return;
    }
    setIsCreating(true);
    try {
      const created = createTask({
        name: trimmedName,
        prompt: trimmedPrompt,
        schedule,
        ...(taskScope === "global" ? { directoryId: "" } : {}),
        apiProfile: selectedApiProfile || undefined,
        basicModel: basicModelOverride.trim() || undefined,
        model: advancedModelOverride.trim() || undefined,
        thinkingStrength: thinkingStrength || undefined,
        preScript: trimmedPreScript || undefined,
        preScriptTimeoutMs: trimmedPreScript
          ? Math.round(timeoutValue * 1000)
          : undefined,
        runOnScriptError: trimmedPreScript ? runOnScriptError : undefined,
      });
      setFilter("all");
      setSelectedTaskId(created.id);
      setPanelMode("details");
      resetFormDraft();
    } catch (error) {
      setFormError(
        t("scheduledTask.errorCreateFailed", {
          defaultValue: "Failed to create task",
        }),
      );
    } finally {
      setIsCreating(false);
    }
  }, [
    advancedModelOverride,
    basicModelOverride,
    buildSchedule,
    createTask,
    directoryId,
    name,
    prompt,
    resetFormDraft,
    selectedApiProfile,
    taskScope,
    thinkingStrength,
    t,
  ]);

  const openCreatePanel = useCallback((): void => {
    resetFormDraft();
    exitEditConfig();
    setPanelMode("create");
  }, [exitEditConfig, resetFormDraft]);

  const closeCreatePanel = useCallback((): void => {
    setFormError(null);
    const selectedIsVisible = visibleTasks.some(
      (task) => task.id === selectedTaskId,
    );
    if (!selectedIsVisible) {
      setSelectedTaskId(visibleTasks[0]?.id ?? null);
    }
    setPanelMode("details");
  }, [selectedTaskId, visibleTasks]);

  const confirmDelete = useCallback((): void => {
    const targetId = deleteTargetId;
    setDeleteTargetId(null);
    if (!targetId) return;

    const targetIndex = visibleTasks.findIndex((task) => task.id === targetId);
    const remainingTasks = tasks.filter((task) => task.id !== targetId);
    const remainingVisibleTasks = getTasksForFilter(remainingTasks, filter);
    removeTask(targetId);

    if (selectedTaskId !== targetId) return;
    if (remainingVisibleTasks.length === 0) {
      setSelectedTaskId(null);
      setPanelMode("create");
      return;
    }

    const nextIndex = Math.min(
      Math.max(targetIndex, 0),
      remainingVisibleTasks.length - 1,
    );
    setSelectedTaskId(remainingVisibleTasks[nextIndex].id);
    setPanelMode("details");
  }, [deleteTargetId, filter, removeTask, selectedTaskId, tasks, visibleTasks]);

  const reconcileAfterScopeClear = useCallback(
    (remainingTasks: ScheduledTaskRecord[]): void => {
      const remainingVisibleTasks = getTasksForFilter(remainingTasks, filter);
      const selectedStillVisible = remainingVisibleTasks.some(
        (task) => task.id === selectedTaskId,
      );
      if (!selectedStillVisible) {
        setSelectedTaskId(remainingVisibleTasks[0]?.id ?? null);
      }
      if (remainingVisibleTasks.length === 0) {
        setPanelMode("create");
      }
    },
    [filter, selectedTaskId],
  );

  const confirmClear = useCallback((): void => {
    setClearOpen(false);
    const remainingTasks = tasks.filter(
      (task) => task.directoryId !== directoryId,
    );
    reconcileAfterScopeClear(remainingTasks);
    clearTasks();
  }, [clearTasks, directoryId, reconcileAfterScopeClear, tasks]);

  const confirmClearGlobal = useCallback((): void => {
    setClearGlobalOpen(false);
    const remainingTasks = tasks.filter((task) => task.directoryId !== "");
    reconcileAfterScopeClear(remainingTasks);
    clearGlobalTasks();
  }, [clearGlobalTasks, reconcileAfterScopeClear, tasks]);

  const resolveApiProfileName = useCallback(
    (profileName: string): string => {
      const config = apiConfigs.find(
        (candidate) => candidate.profileName === profileName,
      );
      return config?.displayName?.trim() || config?.profileName || profileName;
    },
    [apiConfigs],
  );

  const renderHistoryEntry = (
    run: ScheduledTaskRunRecord,
    index: number,
  ): React.JSX.Element => {
    const runStatusLabel = t(
      run.status === "completed"
        ? "scheduledTask.runCompleted"
        : run.status === "error"
          ? "scheduledTask.runFailed"
          : "scheduledTask.runRunning",
      { defaultValue: run.status },
    );
    const runTime =
      formatAbsoluteTime(run.runAt, locale) ??
      t("scheduledTask.invalidSchedule", { defaultValue: "Invalid" });

    return (
      <li
        className={`scheduled-task-history-item ${run.status}`}
        key={`${run.runAt}-${index}`}
      >
        <span className="scheduled-task-history-dot" aria-hidden="true" />
        <div className="scheduled-task-history-content">
          <div className="scheduled-task-history-primary">
            <time className="scheduled-task-history-time">{runTime}</time>
            <span className="scheduled-task-history-status">
              {runStatusLabel}
            </span>
            {run.durationMs != null && (
              <span className="scheduled-task-history-duration">
                {formatDuration(run.durationMs, locale)}
              </span>
            )}
          </div>
          {run.error && (
            <div className="scheduled-task-history-error">{run.error}</div>
          )}
        </div>
      </li>
    );
  };

  const renderTaskItem = (task: ScheduledTaskRecord): React.JSX.Element => {
    const statusKey = getTaskStatusKey(task);
    const statusLabel = t(`scheduledTask.status_${statusKey}`, {
      defaultValue: statusKey,
    });
    const isSelected = task.id === selectedTaskId;
    const scopeLabel = task.directoryId
      ? t("scheduledTask.scopeProject", { defaultValue: "Current project" })
      : t("scheduledTask.scopeGlobal", { defaultValue: "Global" });
    const scheduleLabel = formatSchedule(task.schedule, t, locale);
    const nextRunLabel = task.nextRunAt
      ? (formatRelativeTime(task.nextRunAt, locale) ??
        t("scheduledTask.invalidSchedule", { defaultValue: "Invalid" }))
      : t("scheduledTask.noNextRun", { defaultValue: "No upcoming run" });
    const absoluteNextRun = task.nextRunAt
      ? (formatAbsoluteTime(task.nextRunAt, locale) ?? nextRunLabel)
      : nextRunLabel;

    return (
      <div className="scheduled-task-list-row" key={task.id} role="listitem">
        <button
          aria-label={t("scheduledTask.selectTask", {
            values: { name: task.name },
            defaultValue: `Select task: ${task.name}`,
          })}
          aria-pressed={isSelected}
          className={`scheduled-task-item${isSelected ? " selected" : ""}${
            task.status === "running" ? " is-running" : ""
          }`}
          onClick={() => {
            if (editingConfigTaskId !== task.id) {
              exitEditConfig();
            }
            setSelectedTaskId(task.id);
            setPanelMode("details");
          }}
          type="button"
        >
          <span className="scheduled-task-item-header">
            <span className="scheduled-task-item-name">{task.name}</span>
            <span className={`scheduled-task-item-status-badge ${statusKey}`}>
              {statusLabel}
            </span>
          </span>
          <div className="scheduled-task-item-prompt">
            {previewPrompt(task.prompt)}
          </div>
          {task.preScript && (
            <div className="scheduled-task-item-script" title={task.preScript}>
              <FileCode2 size={12} strokeWidth={1.8} />
              {previewPrompt(task.preScript)}
            </div>
          )}
          <span className="scheduled-task-item-meta">
            <span className="scheduled-task-item-scope">
              {task.directoryId ? (
                <FolderKanban size={12} strokeWidth={1.8} />
              ) : (
                <Globe size={12} strokeWidth={1.8} />
              )}
              {scopeLabel}
            </span>
            <span
              className="scheduled-task-item-schedule"
              title={scheduleLabel}
            >
              {task.schedule.type === "once" ? (
                <CalendarClock size={12} strokeWidth={1.8} />
              ) : task.schedule.mode === "daily" ? (
                <Clock size={12} strokeWidth={1.8} />
              ) : (
                <Repeat size={12} strokeWidth={1.8} />
              )}
              {scheduleLabel}
            </span>
          </span>
          <span className="scheduled-task-item-next" title={absoluteNextRun}>
            <Zap size={12} strokeWidth={1.8} />
            <span>{t("scheduledTask.nextRun", { defaultValue: "Next" })}:</span>
            {nextRunLabel}
          </span>
          {(task.lastRunAt ||
            task.runCount > 0 ||
            task.lastError ||
            task.skipCount > 0) && (
            <span className="scheduled-task-item-meta sub">
              {task.lastRunAt && (
                <span className="scheduled-task-item-last">
                  {t("scheduledTask.lastRun")}: {formatRunTime(task.lastRunAt)}
                </span>
              )}
              {task.runCount > 0 && (
                <span className="scheduled-task-item-runs">
                  {t("scheduledTask.runCount", {
                    values: { count: task.runCount },
                    defaultValue: `${task.runCount} runs`,
                  })}
                </span>
              )}
              {task.skipCount > 0 && (
                <span
                  className="scheduled-task-item-skipped"
                  title={task.lastSkipReason}
                >
                  <SkipForward size={12} strokeWidth={1.8} />
                  {t("scheduledTask.skipCount", {
                    values: { count: task.skipCount },
                    defaultValue: `${task.skipCount} skipped`,
                  })}
                  {task.lastSkipReason
                    ? ` · ${previewPrompt(task.lastSkipReason)}`
                    : ""}
                </span>
              )}
              {task.lastError && (
                <span
                  className="scheduled-task-item-error"
                  title={task.lastError}
                >
                  <AlertCircle size={12} strokeWidth={1.8} />
                  {task.lastError}
                </span>
              )}
            </span>
          )}
        </button>
      </div>
    );
  };

  const renderDetails = (): React.JSX.Element => {
    if (!selectedTask) {
      return (
        <div className="scheduled-task-details-empty">
          <Clock size={30} strokeWidth={1.4} />
          <span>
            {t("scheduledTask.detailsEmpty", {
              defaultValue: "Select a task to view its details.",
            })}
          </span>
        </div>
      );
    }

    const statusKey = getTaskStatusKey(selectedTask);
    const statusLabel = t(`scheduledTask.status_${statusKey}`, {
      defaultValue: statusKey,
    });
    const scopeLabel = selectedTask.directoryId
      ? t("scheduledTask.scopeProject", { defaultValue: "Current project" })
      : t("scheduledTask.scopeGlobal", { defaultValue: "Global" });
    const typeLabel =
      selectedTask.schedule.type === "once"
        ? t("scheduledTask.typeOnce", { defaultValue: "Once" })
        : t("scheduledTask.typeRecurring", { defaultValue: "Recurring" });
    const scheduleLabel = formatSchedule(selectedTask.schedule, t, locale);
    const invalidTimeLabel = t("scheduledTask.invalidSchedule", {
      defaultValue: "Invalid",
    });
    const createdAtLabel =
      formatAbsoluteTime(selectedTask.createdAt, locale) ?? invalidTimeLabel;
    const nextRunLabel = selectedTask.nextRunAt
      ? (formatAbsoluteTime(selectedTask.nextRunAt, locale) ?? invalidTimeLabel)
      : t("scheduledTask.noNextRun", { defaultValue: "No upcoming run" });
    const lastRunLabel = selectedTask.lastRunAt
      ? (formatAbsoluteTime(selectedTask.lastRunAt, locale) ?? invalidTimeLabel)
      : t("scheduledTask.neverRun", { defaultValue: "Never run" });
    const apiProfileLabel = selectedTask.apiProfile
      ? resolveApiProfileName(selectedTask.apiProfile)
      : t("scheduledTask.inheritActiveProfile", {
          defaultValue: "Follow the currently active API config",
        });
    const inheritedProfileLabel = t("scheduledTask.inheritApiProfile", {
      defaultValue: "Follow the API config",
    });
    const thinkingLabel = selectedTask.thinkingStrength
      ? findThinkingOptionLabel(selectedTask.thinkingStrength)
      : inheritedProfileLabel;
    const history = selectedTask.history ?? [];

    return (
      <article className="scheduled-task-details">
        <header className="scheduled-task-details-header">
          <div className="scheduled-task-details-heading">
            <span className="scheduled-task-details-eyebrow">
              {t("scheduledTask.taskDetails", { defaultValue: "Task details" })}
            </span>
            <div className="scheduled-task-details-title-row">
              <h2>{selectedTask.name}</h2>
              <span className={`scheduled-task-item-status-badge ${statusKey}`}>
                {statusLabel}
              </span>
            </div>
          </div>
          <div className="scheduled-task-details-actions">
            <button
              aria-label={t("scheduledTask.runNow", {
                defaultValue: "Run now",
              })}
              className="scheduled-task-action-btn primary"
              disabled={
                selectedTask.status === "running" ||
                selectedTask.status === "completed"
              }
              onClick={() => void runTaskNow(selectedTask.id)}
              title={t("scheduledTask.runNow", { defaultValue: "Run now" })}
              type="button"
            >
              {selectedTask.status === "running" ? (
                <Loader2 className="spin" size={14} strokeWidth={2} />
              ) : (
                <RotateCw size={14} strokeWidth={1.8} />
              )}
              {t("scheduledTask.runNow", { defaultValue: "Run now" })}
            </button>
            {selectedTask.schedule.type === "recurring" && (
              <button
                aria-label={
                  selectedTask.paused
                    ? t("scheduledTask.resume", { defaultValue: "Resume" })
                    : t("scheduledTask.pause", { defaultValue: "Pause" })
                }
                aria-pressed={selectedTask.paused}
                className="scheduled-task-action-btn"
                disabled={selectedTask.status === "running"}
                onClick={() => togglePauseTask(selectedTask.id)}
                type="button"
              >
                {selectedTask.paused ? (
                  <Play size={14} strokeWidth={1.8} />
                ) : (
                  <Pause size={14} strokeWidth={1.8} />
                )}
                {selectedTask.paused
                  ? t("scheduledTask.resume", { defaultValue: "Resume" })
                  : t("scheduledTask.pause", { defaultValue: "Pause" })}
              </button>
            )}
            <button
              aria-label={t("scheduledTask.delete", {
                defaultValue: "Delete",
              })}
              className="scheduled-task-action-btn danger"
              onClick={() => setDeleteTargetId(selectedTask.id)}
              type="button"
            >
              <Trash2 size={14} strokeWidth={1.8} />
              {t("scheduledTask.delete", { defaultValue: "Delete" })}
            </button>
          </div>
        </header>

        <div className="scheduled-task-details-scroll">
          <section
            aria-labelledby="scheduled-task-overview-title"
            className="scheduled-task-details-section"
          >
            <h3 id="scheduled-task-overview-title">
              {t("scheduledTask.overviewTitle", { defaultValue: "Overview" })}
            </h3>
            <dl className="scheduled-task-details-grid">
              <div>
                <dt>{t("scheduledTask.scope", { defaultValue: "Scope" })}</dt>
                <dd>{scopeLabel}</dd>
              </div>
              <div>
                <dt>
                  {t("scheduledTask.taskType", { defaultValue: "Task type" })}
                </dt>
                <dd>
                  {typeLabel} · {scheduleLabel}
                </dd>
              </div>
              <div>
                <dt>
                  {t("scheduledTask.createdAt", { defaultValue: "Created" })}
                </dt>
                <dd>{createdAtLabel}</dd>
              </div>
              <div>
                <dt>{t("scheduledTask.nextRun", { defaultValue: "Next" })}</dt>
                <dd>{nextRunLabel}</dd>
              </div>
              <div>
                <dt>{t("scheduledTask.lastRun", { defaultValue: "Last" })}</dt>
                <dd>{lastRunLabel}</dd>
              </div>
              <div>
                <dt>
                  {t("scheduledTask.historyTitle", {
                    defaultValue: "Run history",
                  })}
                </dt>
                <dd>
                  {t("scheduledTask.runCount", {
                    values: { count: selectedTask.runCount },
                    defaultValue: `${selectedTask.runCount} runs`,
                  })}
                </dd>
              </div>
            </dl>
          </section>

          <section
            aria-labelledby="scheduled-task-run-config-title"
            className="scheduled-task-details-section"
          >
            <div className="scheduled-task-section-heading">
              <h3 id="scheduled-task-run-config-title">
                {t("scheduledTask.runConfigTitle", {
                  defaultValue: "Run configuration",
                })}
              </h3>
              {editingConfigTaskId !== selectedTask.id && (
                <button
                  aria-label={t("scheduledTask.editConfig", {
                    defaultValue: "Edit",
                  })}
                  className="scheduled-task-edit-btn"
                  onClick={() => startEditConfig(selectedTask)}
                  type="button"
                >
                  <Pencil size={13} strokeWidth={1.8} />
                  {t("scheduledTask.editConfig", { defaultValue: "Edit" })}
                </button>
              )}
            </div>
            {editingConfigTaskId === selectedTask.id ? (
              <div className="scheduled-task-config-edit">
                {renderRunConfigFields()}
                <div className="scheduled-task-config-edit-footer">
                  {formError && (
                    <div className="scheduled-tasks-form-error" role="alert">
                      <AlertCircle size={14} strokeWidth={1.8} />
                      <span>{formError}</span>
                    </div>
                  )}
                  <div className="scheduled-tasks-form-actions">
                    <button
                      className="scheduled-tasks-cancel-btn"
                      onClick={exitEditConfig}
                      type="button"
                    >
                      {t("scheduledTask.cancelEdit", {
                        defaultValue: "Cancel",
                      })}
                    </button>
                    <button
                      className="scheduled-tasks-create-btn"
                      onClick={saveEditConfig}
                      type="button"
                    >
                      <Check size={14} strokeWidth={2} />
                      {t("scheduledTask.saveConfig", {
                        defaultValue: "Save",
                      })}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <dl className="scheduled-task-config-grid">
                <div>
                  <dt>
                    {t("scheduledTask.apiProfile", {
                      defaultValue: "API config",
                    })}
                  </dt>
                  <dd className={selectedTask.apiProfile ? "" : " inherited"}>
                    {apiProfileLabel}
                  </dd>
                </div>
                <div>
                  <dt>
                    {t("scheduledTask.basicModel", {
                      defaultValue: "Basic model",
                    })}
                  </dt>
                  <dd className={selectedTask.basicModel ? "" : " inherited"}>
                    {selectedTask.basicModel || inheritedProfileLabel}
                  </dd>
                </div>
                <div>
                  <dt>
                    {t("scheduledTask.advancedModel", {
                      defaultValue: "Advanced model",
                    })}
                  </dt>
                  <dd className={selectedTask.model ? "" : " inherited"}>
                    {selectedTask.model || inheritedProfileLabel}
                  </dd>
                </div>
                <div>
                  <dt>
                    {t("scheduledTask.thinkingStrength", {
                      defaultValue: "Thinking strength",
                    })}
                  </dt>
                  <dd
                    className={
                      selectedTask.thinkingStrength ? "" : " inherited"
                    }
                  >
                    {thinkingLabel}
                  </dd>
                </div>
              </dl>
            )}
          </section>

          <section
            aria-labelledby="scheduled-task-prompt-title"
            className="scheduled-task-details-section"
          >
            <div className="scheduled-task-section-heading">
              <h3 id="scheduled-task-prompt-title">
                {t("scheduledTask.promptTitle", { defaultValue: "Prompt" })}
              </h3>
              <button
                aria-label={t("scheduledTask.copyPrompt", {
                  defaultValue: "Copy prompt",
                })}
                className="scheduled-task-copy-btn"
                onClick={() =>
                  handleCopyPrompt(selectedTask.id, selectedTask.prompt)
                }
                type="button"
              >
                {copiedPromptId === selectedTask.id ? (
                  <Check size={13} strokeWidth={2} />
                ) : (
                  <Copy size={13} strokeWidth={1.8} />
                )}
                {t("scheduledTask.copyPrompt", {
                  defaultValue: "Copy prompt",
                })}
              </button>
            </div>
            <div
              aria-label={t("scheduledTask.promptTitle", {
                defaultValue: "Prompt",
              })}
              className="scheduled-task-prompt-content"
              tabIndex={0}
            >
              {selectedTask.prompt}
            </div>
            {selectedTask.preScript && (
              <div className="scheduled-task-details-pre-script">
                <span className="scheduled-task-details-eyebrow">
                  {t("scheduledTask.preScriptCommand", {
                    defaultValue: "Shell command",
                  })}
                </span>
                <div
                  aria-label={t("scheduledTask.preScriptCommand", {
                    defaultValue: "Shell command",
                  })}
                  className="scheduled-task-prompt-content"
                  tabIndex={0}
                >
                  {selectedTask.preScript}
                </div>
                {selectedTask.runOnScriptError && (
                  <div className="scheduled-tasks-warning">
                    <AlertCircle size={13} strokeWidth={1.8} />
                    <span>
                      {t("scheduledTask.runOnScriptError", {
                        defaultValue: "Run AI even if the script fails",
                      })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </section>

          <section
            aria-labelledby="scheduled-task-history-title"
            className="scheduled-task-details-section"
          >
            <h3 id="scheduled-task-history-title">
              {t("scheduledTask.historyTitle", {
                defaultValue: "Run history",
              })}
            </h3>
            {history.length === 0 ? (
              <div className="scheduled-task-history-empty">
                {t("scheduledTask.noRunHistory", {
                  defaultValue: "No run history yet",
                })}
              </div>
            ) : (
              <ol className="scheduled-task-history-list">
                {[...history]
                  .reverse()
                  .map((run, index) => renderHistoryEntry(run, index))}
              </ol>
            )}
          </section>
        </div>
      </article>
    );
  };

  const activeConfigName = activeConfig
    ? activeConfig.displayName?.trim() || activeConfig.profileName
    : null;
  const basicModelPlaceholder = selectedConfig?.basicModel?.trim()
    ? t("scheduledTask.defaultWithValue", {
        values: { value: selectedConfig.basicModel.trim() },
        defaultValue: `Default (${selectedConfig.basicModel.trim()})`,
      })
    : t("scheduledTask.inheritApiProfile", {
        defaultValue: "Follow the API config",
      });
  const advancedModelPlaceholder = selectedConfig?.advancedModel?.trim()
    ? t("scheduledTask.defaultWithValue", {
        values: { value: selectedConfig.advancedModel.trim() },
        defaultValue: `Default (${selectedConfig.advancedModel.trim()})`,
      })
    : t("scheduledTask.inheritApiProfile", {
        defaultValue: "Follow the API config",
      });

  /** 运行配置表单控件（API 配置下拉 + 基础/高级模型 + 思考强度菜单）。
   *  创建表单与详情视图编辑模式共用；草稿状态与创建表单共享。 */
  const renderRunConfigFields = (): React.JSX.Element => (
    <>
      <label className="scheduled-tasks-field">
        <span>
          {t("scheduledTask.apiProfile", { defaultValue: "API config" })}
        </span>
        <select
          onChange={(event) => handleApiProfileChange(event.target.value)}
          value={selectedApiProfile}
        >
          <option value="">
            {activeConfigName
              ? t("scheduledTask.defaultWithValue", {
                  values: { value: activeConfigName },
                  defaultValue: `Default (${activeConfigName})`,
                })
              : t("scheduledTask.optionDefault", {
                  defaultValue: "Default",
                })}
          </option>
          {apiConfigs.map((config) => (
            <option key={config.profileName} value={config.profileName}>
              {config.displayName.trim() || config.profileName}
              {config.isActive
                ? ` (${t("scheduledTask.activeTag", {
                    defaultValue: "active",
                  })})`
                : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="scheduled-tasks-field-row scheduled-tasks-model-row">
        <ApiModelCombobox
          disabled={false}
          error={modelOptionsError}
          hasLoaded={loadedModelsFor === selectedConfig?.profileName}
          isLoading={isLoadingModelOptions}
          label={t("scheduledTask.basicModel", {
            defaultValue: "Basic model",
          })}
          loadingText={t("settings.loadingModels", {
            defaultValue: "Loading models...",
          })}
          models={modelOptions}
          noModelsText={t("chat.noModelsFound", {
            defaultValue: "No models found",
          })}
          onChange={setBasicModelOverride}
          onRequestModels={() => void loadModelOptions()}
          onRetry={() => void loadModelOptions(true)}
          placeholder={basicModelPlaceholder}
          retryText={t("common.retry", { defaultValue: "Retry" })}
          value={basicModelOverride}
        />
        <ApiModelCombobox
          disabled={false}
          error={modelOptionsError}
          hasLoaded={loadedModelsFor === selectedConfig?.profileName}
          isLoading={isLoadingModelOptions}
          label={t("scheduledTask.advancedModel", {
            defaultValue: "Advanced model",
          })}
          loadingText={t("settings.loadingModels", {
            defaultValue: "Loading models...",
          })}
          models={modelOptions}
          noModelsText={t("chat.noModelsFound", {
            defaultValue: "No models found",
          })}
          onChange={setAdvancedModelOverride}
          onRequestModels={() => void loadModelOptions()}
          onRetry={() => void loadModelOptions(true)}
          placeholder={advancedModelPlaceholder}
          retryText={t("common.retry", { defaultValue: "Retry" })}
          value={advancedModelOverride}
        />
      </div>

      <label className="scheduled-tasks-field">
        <span>
          {t("scheduledTask.thinkingStrength", {
            defaultValue: "Thinking strength",
          })}
        </span>
        <div className="thinking-menu-wrap" ref={thinkingMenuRef}>
          <button
            aria-expanded={isThinkingMenuOpen}
            className="thinking-menu-trigger"
            onClick={() => setIsThinkingMenuOpen((value) => !value)}
            type="button"
          >
            <span>
              {thinkingStrength
                ? findThinkingOptionLabel(thinkingStrength)
                : inheritThinkingLabel}
            </span>
            <ChevronDown size={14} className="thinking-menu-chevron" />
          </button>
          {isThinkingMenuOpen && (
            <div className="model-dropdown drop-down">
              <ThinkingStrengthMenu
                open={isThinkingMenuOpen}
                value={thinkingStrength}
                options={thinkingOptions}
                inheritLabel={inheritThinkingLabel}
                subtitle={requestMethod}
                onSelect={(value) => {
                  setThinkingStrength(value);
                  setIsThinkingMenuOpen(false);
                }}
              />
            </div>
          )}
        </div>
      </label>
      <div className="scheduled-tasks-pre-script">
        <button
          className="scheduled-tasks-pre-script-toggle"
          onClick={() => setPreScriptOpen((open) => !open)}
          type="button"
        >
          {preScriptOpen ? (
            <ChevronDown size={13} strokeWidth={1.9} />
          ) : (
            <ChevronRight size={13} strokeWidth={1.9} />
          )}
          <FileCode2 size={13} strokeWidth={1.9} />
          <span>
            {t("scheduledTask.preScript", {
              defaultValue: "Pre-script (optional)",
            })}
          </span>
        </button>
        {preScriptOpen && (
          <div className="scheduled-tasks-pre-script-body">
            <label className="scheduled-tasks-field">
              <span>
                {t("scheduledTask.preScriptCommand", {
                  defaultValue: "Shell command",
                })}
              </span>
              <textarea
                className="scheduled-tasks-script-textarea"
                onChange={(event) => setPreScript(event.target.value)}
                placeholder={t("scheduledTask.preScriptPlaceholder", {
                  defaultValue: "e.g. git diff --quiet || exit 1",
                })}
                rows={3}
                value={preScript}
              />
            </label>
            <div className="scheduled-tasks-pre-script-hint">
              {t("scheduledTask.preScriptHint", {
                defaultValue:
                  'Exit 0 = run AI, exit 1 = skip. Or print a JSON line: {"run":false,"reason":"...","output":"..."} — "output" fills the {{SCRIPT_OUTPUT}} placeholder in the prompt.',
              })}
            </div>
            <div className="scheduled-tasks-field-row">
              <label className="scheduled-tasks-field">
                <span>
                  {t("scheduledTask.preScriptTimeout", {
                    defaultValue: "Timeout (s)",
                  })}
                </span>
                <input
                  min="1"
                  max="300"
                  onChange={(event) => setPreScriptTimeout(event.target.value)}
                  type="number"
                  value={preScriptTimeout}
                />
              </label>
              <label className="toggle-switch scheduled-tasks-switch-field">
                <input
                  checked={runOnScriptError}
                  onChange={(event) =>
                    setRunOnScriptError(event.target.checked)
                  }
                  type="checkbox"
                />
                <span className="toggle-slider" />
                <span>
                  {t("scheduledTask.runOnScriptError", {
                    defaultValue: "Run AI even if the script fails",
                  })}
                </span>
              </label>
            </div>
          </div>
        )}
      </div>
    </>
  );

  const renderCreateForm = (): React.JSX.Element => (
    <form
      className="scheduled-tasks-form"
      onSubmit={(event) => {
        event.preventDefault();
        void handleCreate();
      }}
    >
      <header className="scheduled-tasks-form-header">
        <div className="scheduled-tasks-form-title">
          <Plus size={16} strokeWidth={2} />
          <span>
            {t("scheduledTask.createNew", {
              defaultValue: "New scheduled task",
            })}
          </span>
        </div>
        {tasks.length > 0 && (
          <button
            className="scheduled-tasks-back-btn"
            onClick={closeCreatePanel}
            type="button"
          >
            {t("scheduledTask.backToDetails", {
              defaultValue: "Back to details",
            })}
          </button>
        )}
      </header>

      <div className="scheduled-tasks-form-scroll">
        <section className="scheduled-tasks-form-section">
          <h3>
            {t("scheduledTask.basicInfoTitle", {
              defaultValue: "Basic information",
            })}
          </h3>
          <label className="scheduled-tasks-field">
            <span>{t("scheduledTask.name", { defaultValue: "Name" })}</span>
            <input
              onChange={(event) => setName(event.target.value)}
              placeholder={t("scheduledTask.namePlaceholder", {
                defaultValue: "e.g. Daily code review reminder",
              })}
              ref={nameInputRef}
              type="text"
              value={name}
            />
          </label>

          <div className="scheduled-tasks-field">
            <span>{t("scheduledTask.prompt", { defaultValue: "Prompt" })}</span>
            <div className="scheduled-tasks-prompt-editor">
              <FileMentionPopup
                ref={mentionPopupRef}
                visible={isMentionOpen}
                query={mentionQuery}
                onClose={handleCloseMention}
                onSelect={handleMentionSelect}
                onSelectBatch={handleMentionSelectBatch}
                textareaRef={promptInputRef}
                onNavigateTo={replaceMentionQuery}
                style={mentionPopupStyle}
                portal
              />
              <div
                aria-label={t("scheduledTask.prompt", {
                  defaultValue: "Prompt",
                })}
                aria-multiline="true"
                className="scheduled-tasks-prompt-textarea input-field-editable"
                contentEditable
                data-empty="true"
                data-placeholder={t("scheduledTask.promptPlaceholder", {
                  defaultValue:
                    "Prompt sent to the AI Loop on each run. The task has access to all tools.",
                })}
                onClick={handlePromptClick}
                onDragLeave={handlePromptDragLeave}
                onDragOver={handlePromptDragOver}
                onDrop={handlePromptDrop}
                onInput={handlePromptInput}
                onKeyDown={handlePromptKeyDown}
                onPaste={handlePromptPaste}
                ref={promptInputRef}
                role="textbox"
                suppressContentEditableWarning
              />
            </div>
          </div>

          <div className="scheduled-tasks-field">
            <span>{t("scheduledTask.scope", { defaultValue: "Scope" })}</span>
            <div
              aria-label={t("scheduledTask.scope", { defaultValue: "Scope" })}
              className="scheduled-tasks-segmented"
              role="group"
            >
              <button
                aria-pressed={taskScope === "project"}
                className={`scheduled-tasks-segmented-btn${
                  taskScope === "project" ? " active" : ""
                }`}
                disabled={!directoryId}
                onClick={() => setTaskScope("project")}
                title={
                  !directoryId
                    ? t("scheduledTask.scopeProjectDisabled", {
                        defaultValue: "No active project",
                      })
                    : undefined
                }
                type="button"
              >
                <FolderKanban size={13} strokeWidth={1.9} />
                {t("scheduledTask.scopeProject", {
                  defaultValue: "Current project",
                })}
              </button>
              <button
                aria-pressed={taskScope === "global"}
                className={`scheduled-tasks-segmented-btn${
                  taskScope === "global" ? " active" : ""
                }`}
                onClick={() => setTaskScope("global")}
                type="button"
              >
                <Globe size={13} strokeWidth={1.9} />
                {t("scheduledTask.scopeGlobal", { defaultValue: "Global" })}
              </button>
            </div>
          </div>
        </section>

        <section className="scheduled-tasks-form-section">
          <h3>
            {t("scheduledTask.scheduleSettingsTitle", {
              defaultValue: "Schedule settings",
            })}
          </h3>
          <div className="scheduled-tasks-field">
            <span>
              {t("scheduledTask.taskType", { defaultValue: "Task type" })}
            </span>
            <div
              aria-label={t("scheduledTask.taskType", {
                defaultValue: "Task type",
              })}
              className="scheduled-tasks-segmented"
              role="group"
            >
              <button
                aria-pressed={taskType === "once"}
                className={`scheduled-tasks-segmented-btn${
                  taskType === "once" ? " active" : ""
                }`}
                onClick={() => setTaskType("once")}
                type="button"
              >
                <CalendarClock size={13} strokeWidth={1.9} />
                {t("scheduledTask.typeOnce", { defaultValue: "Once" })}
              </button>
              <button
                aria-pressed={taskType === "recurring"}
                className={`scheduled-tasks-segmented-btn${
                  taskType === "recurring" ? " active" : ""
                }`}
                onClick={() => setTaskType("recurring")}
                type="button"
              >
                <Repeat size={13} strokeWidth={1.9} />
                {t("scheduledTask.typeRecurring", {
                  defaultValue: "Recurring",
                })}
              </button>
            </div>
          </div>

          {taskType === "once" ? (
            <label className="scheduled-tasks-field">
              <span>
                {t("scheduledTask.startTime", { defaultValue: "Start time" })}
              </span>
              <input
                onChange={(event) => setExecuteAtLocal(event.target.value)}
                type="datetime-local"
                value={executeAtLocal}
              />
            </label>
          ) : (
            <>
              <div className="scheduled-tasks-field">
                <span>
                  {t("scheduledTask.recurringMode", {
                    defaultValue: "Repeat mode",
                  })}
                </span>
                <div
                  aria-label={t("scheduledTask.recurringMode", {
                    defaultValue: "Repeat mode",
                  })}
                  className="scheduled-tasks-segmented"
                  role="group"
                >
                  <button
                    aria-pressed={recurringMode === "interval"}
                    className={`scheduled-tasks-segmented-btn${
                      recurringMode === "interval" ? " active" : ""
                    }`}
                    onClick={() => setRecurringMode("interval")}
                    type="button"
                  >
                    <Repeat size={13} strokeWidth={1.9} />
                    {t("scheduledTask.modeInterval", {
                      defaultValue: "Interval",
                    })}
                  </button>
                  <button
                    aria-pressed={recurringMode === "daily"}
                    className={`scheduled-tasks-segmented-btn${
                      recurringMode === "daily" ? " active" : ""
                    }`}
                    onClick={() => setRecurringMode("daily")}
                    type="button"
                  >
                    <Clock size={13} strokeWidth={1.9} />
                    {t("scheduledTask.modeDaily", { defaultValue: "Daily" })}
                  </button>
                </div>
              </div>

              {recurringMode === "interval" ? (
                <div className="scheduled-tasks-field-row">
                  <label className="scheduled-tasks-field">
                    <span>
                      {t("scheduledTask.intervalValue", {
                        defaultValue: "Every",
                      })}
                    </span>
                    <input
                      min="1"
                      onChange={(event) => setIntervalValue(event.target.value)}
                      type="number"
                      value={intervalValue}
                    />
                  </label>
                  <label className="scheduled-tasks-field">
                    <span>
                      {t("scheduledTask.intervalUnit", {
                        defaultValue: "Unit",
                      })}
                    </span>
                    <select
                      onChange={(event) =>
                        setIntervalUnit(
                          event.target.value as "minutes" | "hours",
                        )
                      }
                      value={intervalUnit}
                    >
                      <option value="minutes">
                        {t("scheduledTask.unitMinutes", {
                          defaultValue: "minutes",
                        })}
                      </option>
                      <option value="hours">
                        {t("scheduledTask.unitHours", {
                          defaultValue: "hours",
                        })}
                      </option>
                    </select>
                  </label>
                </div>
              ) : (
                <div className="scheduled-tasks-field-row">
                  <label className="scheduled-tasks-field">
                    <span>
                      {t("scheduledTask.dailyHour", { defaultValue: "Hour" })}
                    </span>
                    <select
                      onChange={(event) => setDailyHour(event.target.value)}
                      value={dailyHour}
                    >
                      {Array.from({ length: 24 }, (_, hour) => hour).map(
                        (hour) => (
                          <option key={hour} value={hour.toString()}>
                            {pad2(hour)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="scheduled-tasks-field">
                    <span>
                      {t("scheduledTask.dailyMinute", {
                        defaultValue: "Minute",
                      })}
                    </span>
                    <select
                      onChange={(event) => setDailyMinute(event.target.value)}
                      value={dailyMinute}
                    >
                      {[0, 15, 30, 45].map((minute) => (
                        <option key={minute} value={minute.toString()}>
                          {pad2(minute)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </>
          )}
        </section>

        <section className="scheduled-tasks-form-section">
          <h3>
            {t("scheduledTask.runConfigSettingsTitle", {
              defaultValue: "Run configuration",
            })}
          </h3>
          {renderRunConfigFields()}
        </section>
      </div>

      <footer className="scheduled-tasks-form-footer">
        {formError && (
          <div className="scheduled-tasks-form-error" role="alert">
            <AlertCircle size={14} strokeWidth={1.8} />
            <span>{formError}</span>
          </div>
        )}
        <div className="scheduled-tasks-form-actions">
          {tasks.length > 0 && (
            <button
              className="scheduled-tasks-cancel-btn"
              onClick={closeCreatePanel}
              type="button"
            >
              {t("scheduledTask.cancelCreate", {
                defaultValue: "Cancel creation",
              })}
            </button>
          )}
          <button
            className="scheduled-tasks-create-btn"
            disabled={isCreating || (taskScope === "project" && !directoryId)}
            type="submit"
          >
            {isCreating ? (
              <Loader2 className="spin" size={15} strokeWidth={2.2} />
            ) : (
              <Plus size={15} strokeWidth={2.2} />
            )}
            {t("scheduledTask.create", { defaultValue: "Create task" })}
          </button>
        </div>
      </footer>
    </form>
  );

  const filterOptions: Array<{
    key: TaskFilter;
    label: string;
    count: number;
    disabled?: boolean;
  }> = [
    {
      key: "all",
      label: t("scheduledTask.filterAll", { defaultValue: "All" }),
      count: tasks.length,
    },
    {
      key: "project",
      label: t("scheduledTask.filterProject", {
        defaultValue: "Current project",
      }),
      count: projectTasks.length,
      disabled: !directoryId,
    },
    {
      key: "global",
      label: t("scheduledTask.filterGlobal", { defaultValue: "Global" }),
      count: globalTasks.length,
    },
  ];

  return (
    <Modal
      className="scheduled-tasks-modal"
      closeLabel={t("scheduledTask.close", { defaultValue: "Close" })}
      onClose={onClose}
      open={open}
      size="large"
      title={t("scheduledTask.title", { defaultValue: "Scheduled Tasks" })}
    >
      <div className="scheduled-tasks-modal-layout">
        <aside className="scheduled-tasks-sidebar">
          <div className="scheduled-tasks-sidebar-header">
            <div
              aria-label={t("scheduledTask.taskListLabel", {
                defaultValue: "Scheduled task list",
              })}
              className="scheduled-tasks-filter-tabs"
              role="group"
            >
              {filterOptions.map((option) => (
                <button
                  aria-pressed={filter === option.key}
                  className={`scheduled-tasks-filter-tab${
                    filter === option.key ? " active" : ""
                  }`}
                  disabled={option.disabled}
                  key={option.key}
                  onClick={() => setFilter(option.key)}
                  type="button"
                >
                  <span>{option.label}</span>
                  <span
                    aria-label={t("scheduledTask.taskCount", {
                      values: { count: option.count },
                      defaultValue: `${option.count} tasks`,
                    })}
                    className="scheduled-tasks-count"
                  >
                    {option.count}
                  </span>
                </button>
              ))}
            </div>
            <button
              className="scheduled-tasks-new-btn"
              onClick={openCreatePanel}
              type="button"
            >
              <Plus size={14} strokeWidth={2.2} />
              {t("scheduledTask.newTask", { defaultValue: "New task" })}
            </button>
          </div>

          <div
            aria-label={t("scheduledTask.taskListLabel", {
              defaultValue: "Scheduled task list",
            })}
            className="scheduled-tasks-list-scroll"
            role="list"
          >
            {visibleTasks.length === 0 ? (
              <div className="scheduled-tasks-empty">
                <Clock size={28} strokeWidth={1.4} />
                <span>
                  {tasks.length === 0
                    ? t("scheduledTask.emptyHint", {
                        defaultValue:
                          "No scheduled tasks yet. Create one on the right.",
                      })
                    : t("scheduledTask.emptyFiltered", {
                        defaultValue: "No tasks match this filter.",
                      })}
                </span>
              </div>
            ) : (
              visibleTasks.map(renderTaskItem)
            )}
          </div>

          <div className="scheduled-tasks-sidebar-footer">
            {!isExecutorReady && (
              <div className="scheduled-tasks-warning">
                <AlertCircle size={13} strokeWidth={1.8} />
                <span>
                  {t("scheduledTask.executorUnavailable", {
                    defaultValue:
                      "AI Loop unavailable — tasks will not run until the chat is ready.",
                  })}
                </span>
              </div>
            )}
            {(filter !== "global" && directoryId && projectTasks.length > 0) ||
            (filter !== "project" && globalTasks.length > 0) ? (
              <div className="scheduled-tasks-scope-actions">
                {filter !== "global" &&
                  directoryId &&
                  projectTasks.length > 0 && (
                    <button
                      className="scheduled-tasks-clear-btn"
                      onClick={() => setClearOpen(true)}
                      type="button"
                    >
                      <Trash2 size={13} strokeWidth={1.8} />
                      {t("scheduledTask.clearProject", {
                        defaultValue: "Clear current project tasks",
                      })}
                    </button>
                  )}
                {filter !== "project" && globalTasks.length > 0 && (
                  <button
                    className="scheduled-tasks-clear-btn"
                    onClick={() => setClearGlobalOpen(true)}
                    type="button"
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                    {t("scheduledTask.clearGlobal", {
                      defaultValue: "Clear global tasks",
                    })}
                  </button>
                )}
              </div>
            ) : null}
            <div className="scheduled-tasks-lifetime-hint">
              {t("scheduledTask.lifetimeHint", {
                defaultValue:
                  "Tasks are saved locally and kept after restarting the app. Executions missed while the app is closed are skipped.",
              })}
            </div>
          </div>
        </aside>

        <main className="scheduled-tasks-content">
          {panelMode === "create" ? renderCreateForm() : renderDetails()}
        </main>
      </div>

      <ConfirmDialog
        cancelLabel={t("scheduledTask.cancelDelete", {
          defaultValue: "Cancel",
        })}
        confirmLabel={t("scheduledTask.delete", { defaultValue: "Delete" })}
        message={t("scheduledTask.confirmDelete", {
          defaultValue: "Delete this scheduled task?",
          values: { name: deleteTarget?.name ?? "" },
        })}
        onCancel={() => setDeleteTargetId(null)}
        onConfirm={confirmDelete}
        open={deleteTargetId !== null}
        title={t("scheduledTask.delete", { defaultValue: "Delete" })}
        variant="danger"
      />
      <ConfirmDialog
        cancelLabel={t("scheduledTask.cancelDelete", {
          defaultValue: "Cancel",
        })}
        confirmLabel={t("scheduledTask.clearProject", {
          defaultValue: "Clear current project tasks",
        })}
        message={t("scheduledTask.confirmClearProject", {
          defaultValue:
            "Remove all scheduled tasks for the current project? This cannot be undone.",
        })}
        onCancel={() => setClearOpen(false)}
        onConfirm={confirmClear}
        open={clearOpen}
        title={t("scheduledTask.clearProject", {
          defaultValue: "Clear current project tasks",
        })}
        variant="danger"
      />
      <ConfirmDialog
        cancelLabel={t("scheduledTask.cancelDelete", {
          defaultValue: "Cancel",
        })}
        confirmLabel={t("scheduledTask.clearGlobal", {
          defaultValue: "Clear global tasks",
        })}
        message={t("scheduledTask.confirmClearGlobal", {
          defaultValue:
            "Remove all global scheduled tasks? This cannot be undone.",
        })}
        onCancel={() => setClearGlobalOpen(false)}
        onConfirm={confirmClearGlobal}
        open={clearGlobalOpen}
        title={t("scheduledTask.clearGlobal", {
          defaultValue: "Clear global tasks",
        })}
        variant="danger"
      />
    </Modal>
  );
}
