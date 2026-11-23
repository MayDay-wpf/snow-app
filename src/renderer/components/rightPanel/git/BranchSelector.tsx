import {
  GitBranch,
  ChevronDown,
  GitBranchPlus,
  RefreshCw,
  Copy,
  X,
  Loader2,
  FolderGit2,
  Search,
  Terminal,
  Trash2,
  Check,
  Folder,
  MessageSquarePlus,
  Info,
  AlertCircle,
  Sparkles,
  FileDiff,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GitBranch as GitBranchType,
  GitFileStatus,
  GitWorktreeInfo,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import {
  formatDisplayPath,
  normalizePathForCompare,
} from "../../../utils/formatDisplayPath";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { EditContextMenu } from "../../common/EditContextMenu";
import { resolveEditableTarget } from "../../common/GlobalEditContextMenu";
import { useEditContextMenu } from "../../../hooks/useEditContextMenu";
import { useChatConversationContext } from "../../mainContent/chatMessages";
import { rightPanelEvents } from "../rightPanelEvents";
import { notifyConversationWorktreeChanged } from "../../../utils/conversationWorktreeEvents";
import { GitControl } from "./GitControl";
import { WorktreeBaseRefSelect } from "./WorktreeBaseRefSelect";
import { BRANCHES_CHANGED, useBranchManagement } from "./useBranchManagement";

type BranchSelectorProps = {
  repoPath: string;
  currentBranch: string;
  directoryId?: string | null;
  onBranchChanged: () => void;
  onOpenTerminal?: (cwd: string) => void;
  /** 为 true 时下拉层切为「分支 / 变更」双 Tab，变更 Tab 内嵌 GitControl */
  showChangesTab?: boolean;
  /** 变更 Tab 上的文件数徽标 */
  changesCount?: number;
};

const INVALID_REF_CHAR = /[\x00-\x20\x7f~^:?*\[\\]/;

const isValidBranchName = (branch: string): boolean => {
  if (
    branch.length === 0 ||
    branch.trim() !== branch ||
    branch === "@" ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("//") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    INVALID_REF_CHAR.test(branch)
  ) {
    return false;
  }
  return branch
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
    );
};

/** 提取末级工作树文件夹名称（如 chat, clone 等）。 */
const getFolderName = (p: string): string => {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
};

const normPath = (p: string | null | undefined): string => {
  if (!p) return "";
  return normalizePathForCompare(p);
};

export const BranchSelector = ({
  repoPath,
  currentBranch,
  directoryId,
  onBranchChanged,
  onOpenTerminal,
  showChangesTab = false,
  changesCount = 0,
}: BranchSelectorProps): React.JSX.Element => {
  const { t } = useI18n();
  const management = useBranchManagement(repoPath, () => {
    setIsOpen(false);
  });
  const branchRequestRef = useRef(0);
  const worktreeRequestRef = useRef(0);
  const activeRepoRef = useRef(repoPath);
  activeRepoRef.current = repoPath;
  useEffect(() => {
    setBranchItemContextMenu(null);
    setContextMenu(null);
    setIsOpen(false);
    setBranches([]);
    setWorktrees([]);
    setCreateMode(null);
    setNewBranchName("");
    setLoading(false);
    setCreateError(null);
    const changed = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === repoPath) {
        loadBranches();
        onBranchChanged();
      }
    };
    window.addEventListener(BRANCHES_CHANGED, changed);
    return () => {
      branchRequestRef.current++;
      worktreeRequestRef.current++;
      window.removeEventListener(BRANCHES_CHANGED, changed);
    };
  }, [repoPath]);
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // 创建面板状态：null 不显示, 'branch' 新建分支, 'worktree' 新建工作树
  const [createMode, setCreateMode] = useState<"branch" | "worktree" | null>(
    null,
  );
  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBranchName, setWorktreeBranchName] = useState("");
  const [worktreeBaseRef, setWorktreeBaseRef] = useState("HEAD");
  const [isCustomBaseRef, setIsCustomBaseRef] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 删除工作树确认
  const [removeWorktreeTarget, setRemoveWorktreeTarget] =
    useState<GitWorktreeInfo | null>(null);
  const [removingWorktree, setRemovingWorktree] = useState(false);

  // 剪贴板复制提示
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [branchItemContextMenu, setBranchItemContextMenu] = useState<{
    x: number;
    y: number;
    branch: GitBranchType;
  } | null>(null);

  // 输入框右键：统一走通用编辑菜单（剪切 / 复制 / 粘贴 / 全选）
  const { editMenu, openEditMenuForElement, runEditCommand, closeEditMenu } =
    useEditContextMenu();
  // 编辑菜单 Portal 挂在 body，下拉的外部点击判定需单独识别
  const editMenuOpenRef = useRef(false);
  editMenuOpenRef.current = editMenu !== null;

  const [searchQuery, setSearchQuery] = useState("");
  // 弹出层宽度上限：按「按钮左边缘到视口右侧」的可用空间收敛。仅靠 CSS 的
  // 100vw 无法扣除下拉开在按钮处带来的左侧偏移，窄窗口（或高 DPI 缩放下
  // CSS 视口变小时）仍会顶出窗口右侧被裁切。
  const [dropdownWidthCap, setDropdownWidthCap] = useState<number | null>(null);
  // 右侧空间不足（如右面板收起后按钮贴近窗口右缘）时改为右对齐向左展开
  const [dropdownAlignRight, setDropdownAlignRight] = useState(false);
  // 选择器根容器：按钮与弹出层都要被视为「内部」。若只把弹出层当内部，
  // 点击按钮时 mousedown 先判定为外部点击而关闭，紧接着的 click 又按
  // 「当前未展开」重新打开并触发一次列表加载，表现为「点第二下变刷新」。
  const dropdownRef = useRef<HTMLDivElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const worktreeInputRef = useRef<HTMLInputElement>(null);
  const customRefInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 双 Tab 模式下的当前 Tab；未启用时恒为分支视图
  const [activeTab, setActiveTab] = useState<"branches" | "changes">(
    "branches",
  );
  const currentTab = showChangesTab ? activeTab : "branches";
  // 合成事件沿组件树冒泡（含 Portal 弹层/对话框），据此把它们的点击视为内部
  const insideMouseDownRef = useRef(false);

  const normalizedRepoPath = useMemo(() => normPath(repoPath), [repoPath]);

  const isOtherWorktreePath = useCallback(
    (wtPath: string | null | undefined): boolean => {
      if (!wtPath) return false;
      return normPath(wtPath) !== normalizedRepoPath;
    },
    [normalizedRepoPath],
  );

  /** 本地主干分支检测 (main 或 master) */
  const defaultMainBranch = useMemo(() => {
    const local = branches.filter((b) => !b.isRemote).map((b) => b.name);
    if (local.includes("main")) return "main";
    if (local.includes("master")) return "master";
    return null;
  }, [branches]);

  /** 全部本地分支名称 */
  const allLocalBranchNames = useMemo(
    () => branches.filter((b) => !b.isRemote).map((b) => b.name),
    [branches],
  );

  const trimmedWorktreeBranchName = worktreeBranchName.trim();

  /** 分支名称合法性与重复性即时校验 */
  const isBranchNameExisting = useMemo(() => {
    if (!trimmedWorktreeBranchName) return false;
    return branches.some(
      (b) => !b.isRemote && b.name === trimmedWorktreeBranchName,
    );
  }, [trimmedWorktreeBranchName, branches]);

  const isBranchCheckedOutInWorktree = useMemo(() => {
    if (!trimmedWorktreeBranchName) return false;
    return worktrees.some((wt) => wt.branchName === trimmedWorktreeBranchName);
  }, [trimmedWorktreeBranchName, worktrees]);

  const isBranchNameFormatInvalid = useMemo(() => {
    if (!trimmedWorktreeBranchName) return false;
    return !isValidBranchName(trimmedWorktreeBranchName);
  }, [trimmedWorktreeBranchName]);

  const branchNameValidationError = useMemo(() => {
    if (isBranchNameExisting) {
      return t("git.worktreeBranchExists", {
        defaultValue: "该分支在本地已存在，工作树需指定新分支",
      });
    }
    if (isBranchCheckedOutInWorktree) {
      return t("git.worktreeBranchCheckedOut", {
        defaultValue: "该分支已在其他工作树检出",
      });
    }
    if (isBranchNameFormatInvalid) {
      return t("git.worktreeBranchInvalidFormat", {
        defaultValue: "分支名称格式不符合 Git 规范",
      });
    }
    return null;
  }, [
    isBranchNameExisting,
    isBranchCheckedOutInWorktree,
    isBranchNameFormatInvalid,
    t,
  ]);

  /** 基线作用动态解析与说明 */
  const baseRefDescription = useMemo(() => {
    const trimmed = worktreeBaseRef.trim();
    if (!trimmed || trimmed === "HEAD") {
      return t("git.worktreeBaseHeadHint", {
        values: { branch: currentBranch || "HEAD" },
        defaultValue: `基于当前工作状态 (${currentBranch || "HEAD"}) 创建，适合延续进度的实验开发`,
      });
    }
    if (defaultMainBranch && trimmed === defaultMainBranch) {
      return t("git.worktreeBaseMainHint", {
        values: { branch: defaultMainBranch },
        defaultValue: `基于主干分支 (${defaultMainBranch}) 创建，纯净无污染，适合全新功能开发`,
      });
    }
    const isKnownLocal = branches.some(
      (b) => !b.isRemote && b.name === trimmed,
    );
    if (isKnownLocal) {
      return t("git.worktreeBaseBranchHint", {
        values: { branch: trimmed },
        defaultValue: `基于本地分支 '${trimmed}' 的最新提交创建`,
      });
    }
    return t("git.worktreeBaseCustomHint", {
      values: { ref: trimmed },
      defaultValue: `基于自定义引用/提交 '${trimmed}' 创建`,
    });
  }, [worktreeBaseRef, currentBranch, defaultMainBranch, branches, t]);

  /** 智能生成未占用的唯一分支名 */
  const handleGenerateBranchName = useCallback(
    (prefix = "feature/"): void => {
      const dateStr = new Date().toISOString().slice(5, 10).replace("-", "");
      const randomSuffix = Math.random().toString(36).substring(2, 6);
      let candidate = `${prefix}wt-${dateStr}-${randomSuffix}`;
      let counter = 1;
      while (
        branches.some((b) => !b.isRemote && b.name === candidate) ||
        worktrees.some((wt) => wt.branchName === candidate)
      ) {
        candidate = `${prefix}wt-${dateStr}-${randomSuffix}${counter++}`;
      }
      setWorktreeBranchName(candidate);
      setCreateError(null);
    },
    [branches, worktrees],
  );

  /** 快捷添加或替换分支前缀 */
  const handleApplyPrefix = useCallback((prefix: string): void => {
    setWorktreeBranchName((prev) => {
      const clean = prev.replace(/^(feature|fix|task|test|temp)\//, "");
      return `${prefix}${clean}`;
    });
    worktreeInputRef.current?.focus();
  }, []);

  /** 加载分支列表，丢弃项目切换或更新请求之前的响应。 */
  const loadBranches = useCallback(() => {
    const request = ++branchRequestRef.current;
    setLoading(true);
    window.snow
      .gitBranches(repoPath)
      .then((result) => {
        if (
          request === branchRequestRef.current &&
          activeRepoRef.current === repoPath
        )
          setBranches(result);
      })
      .catch((cause) => {
        if (
          request === branchRequestRef.current &&
          activeRepoRef.current === repoPath
        )
          setCreateError(String(cause));
      })
      .finally(() => {
        if (
          request === branchRequestRef.current &&
          activeRepoRef.current === repoPath
        )
          setLoading(false);
      });
  }, [repoPath]);

  /** 加载工作树列表。 */
  const loadWorktrees = useCallback(() => {
    const request = ++worktreeRequestRef.current;
    if (!directoryId) {
      setWorktrees([]);
      return;
    }
    window.snow
      .gitListWorktrees(directoryId)
      .then((items) => {
        if (request === worktreeRequestRef.current) setWorktrees(items);
      })
      .catch(() => {
        if (request === worktreeRequestRef.current) setWorktrees([]);
      });
  }, [directoryId]);

  useEffect(() => {
    loadWorktrees();
    window.addEventListener("snow:worktrees-changed", loadWorktrees);
    return () => {
      window.removeEventListener("snow:worktrees-changed", loadWorktrees);
    };
  }, [loadWorktrees]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    loadBranches();
    loadWorktrees();
  }, [isOpen, loadBranches, loadWorktrees]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // 每个手势开始前先清空上一手势残留的内部标记：打开下拉那次 mousedown
    // 早于本监听注册，标记会一直为 true，导致首次点空白被判为内部而不收起。
    const resetInsideMark = (): void => {
      insideMouseDownRef.current = false;
    };

    const handleClickOutside = (event: MouseEvent): void => {
      // 内部点击（根容器 or Portal 弹层）已由 onMouseDown 标记为 true
      if (insideMouseDownRef.current) return;
      // 编辑菜单（Portal 到 body）内的点击不能收起下拉，否则粘贴 / 全选落空
      if (
        editMenuOpenRef.current &&
        event.target instanceof Element &&
        event.target.closest(".context-menu")
      ) {
        return;
      }
      setIsOpen(false);
      setCreateMode(null);
      setNewBranchName("");
      setWorktreeBranchName("");
      setCreateError(null);
      setSearchQuery("");
    };

    // 捕获阶段先重置，再由根容器的 onMouseDown 标记内部点击（含 Portal 弹层）
    document.addEventListener("mousedown", resetInsideMark, true);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", resetInsideMark, true);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // 下拉收起时一并关闭输入框编辑菜单，避免悬浮残留
  useEffect(() => {
    if (!isOpen) closeEditMenu();
  }, [isOpen, closeEditMenu]);

  // 布局阶段测量，避免先左对齐绘制一帧再翻转的闪烁
  useLayoutEffect(() => {
    if (!isOpen) {
      setDropdownWidthCap(null);
      setDropdownAlignRight(false);
      return;
    }

    const updateCap = (): void => {
      const rect = dropdownRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      // 两侧各留 16px 安全边距；右侧放不下 330px 且左侧更宽时翻转为右对齐。
      const rightSpace = window.innerWidth - rect.left - 16;
      const leftSpace = rect.right - 16;
      const alignRight = rightSpace < 330 && leftSpace > rightSpace;
      const available = alignRight ? leftSpace : rightSpace;
      setDropdownAlignRight(alignRight);
      setDropdownWidthCap(Math.max(220, Math.min(440, available)));
    };

    updateCap();
    window.addEventListener("resize", updateCap);
    return () => window.removeEventListener("resize", updateCap);
  }, [isOpen]);

  useEffect(() => {
    if (createMode === "branch") {
      branchInputRef.current?.focus();
    } else if (createMode === "worktree") {
      worktreeInputRef.current?.focus();
    }
  }, [createMode]);

  const handleCheckout = (branch: GitBranchType): void => {
    if (branch.isCurrent) {
      setIsOpen(false);
      return;
    }
    management.checkout(branch);
  };

  /** 新建普通分支 */
  const handleCreateBranch = (): void => {
    if (management.busy || management.sessionRunning || creating) return;
    const trimmed = newBranchName.trim();
    if (!isValidBranchName(newBranchName)) {
      setCreateError(t("git.createBranchInvalid"));
      return;
    }

    const exists = branches.some((b) => !b.isRemote && b.name === trimmed);
    if (exists) {
      setCreateError(t("git.createBranchExists"));
      return;
    }

    setCreating(true);
    setCreateError(null);
    window.snow
      .gitCreateBranch(repoPath, trimmed)
      .then((result) => {
        if (result.success) {
          setCreateMode(null);
          setNewBranchName("");
          setIsOpen(false);
          onBranchChanged();
        } else {
          setCreateError(result.message || t("git.createBranchFailed"));
        }
      })
      .catch(() => {
        setCreateError(t("git.createBranchFailed"));
      })
      .finally(() => {
        setCreating(false);
      });
  };

  /** 新建独立工作树 */
  const handleCreateWorktree = (): void => {
    if (
      !directoryId ||
      !trimmedWorktreeBranchName ||
      creating ||
      Boolean(branchNameValidationError)
    )
      return;
    setCreating(true);
    setCreateError(null);
    window.snow
      .gitCreateWorktree(
        directoryId,
        trimmedWorktreeBranchName,
        worktreeBaseRef.trim() || "HEAD",
      )
      .then((created) => {
        window.dispatchEvent(new Event("snow:worktrees-changed"));
        setWorktrees((items) => [
          ...items.filter((item) => item.worktreeId !== created.worktreeId),
          created,
        ]);
        setWorktreeBranchName("");
        setWorktreeBaseRef("HEAD");
        setCreateMode(null);
        loadBranches();
        onBranchChanged();
      })
      .catch((cause: unknown) => {
        setCreateError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setCreating(false);
      });
  };

  /** 删除工作树 */
  const handleConfirmRemoveWorktree = (): void => {
    if (!directoryId || !removeWorktreeTarget || removingWorktree) return;
    setRemovingWorktree(true);
    setCreateError(null);
    window.snow
      .gitRemoveWorktree(directoryId, removeWorktreeTarget.worktreeId)
      .then(() => {
        if (
          chatContext?.pendingWorktreeId === removeWorktreeTarget.worktreeId
        ) {
          chatContext.setPendingWorktreeId(null);
        }
        setRemoveWorktreeTarget(null);
        window.dispatchEvent(new Event("snow:worktrees-changed"));
        loadWorktrees();
        loadBranches();
        onBranchChanged();
      })
      .catch((cause: unknown) => {
        const rawDetail =
          cause instanceof Error ? cause.message : String(cause);
        const detail = rawDetail
          .replace(/^Error invoking remote method '[^']+':\s*/i, "")
          .replace(/^Error:\s*/i, "")
          .trim();
        setCreateError(
          /dirty|modified|uncommitted|未提交|修改/i.test(detail)
            ? t("git.worktreeRemoveDirty", {
                defaultValue: "工作树包含未提交的修改，无法安全删除",
              })
            : detail ||
                t("git.worktreeRemoveFailed", {
                  defaultValue: "删除工作树失败",
                }),
        );
      })
      .finally(() => {
        setRemovingWorktree(false);
      });
  };

  const handleCopyPath = (id: string, path: string): void => {
    void window.snow.writeClipboardText(path).then(() => {
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1500);
    });
  };

  let chatContext: ReturnType<typeof useChatConversationContext> | null = null;
  try {
    chatContext = useChatConversationContext();
  } catch {
    chatContext = null;
  }

  const isSessionRunning = Boolean(
    chatContext?.isStreaming ||
    chatContext?.isAborting ||
    chatContext?.isCompacting,
  );

  const handleSelectWorktreeForChat = (wt: GitWorktreeInfo): void => {
    // Match the chat input selector: never change a running conversation's
    // persisted binding while its tools and checkpoint use the current tree.
    if (!chatContext || isSessionRunning) return;
    if (chatContext.activeConversationId) {
      void window.snow
        .setConversationWorktree(
          chatContext.activeConversationId,
          wt.worktreeId,
        )
        .then(notifyConversationWorktreeChanged);
    } else {
      chatContext.setPendingWorktreeId(wt.worktreeId);
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".chat-input-textarea",
      );
      textarea?.focus();
    }
    setIsOpen(false);
  };

  const handleStartNewChatInWorktree = (
    e: React.MouseEvent,
    wt: GitWorktreeInfo,
  ): void => {
    e.stopPropagation();
    if (!chatContext) return;
    chatContext.handleNewChat(directoryId || undefined);
    chatContext.setPendingWorktreeId(wt.worktreeId);
    setIsOpen(false);
    setTimeout(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".chat-input-textarea",
      );
      textarea?.focus();
    }, 60);
  };

  // 变更 Tab：差异/原文/终端交给右面板打开（会自动展开），随后收起下拉
  const handleChangesFileSelect = useCallback(
    (file: GitFileStatus | null, section?: "staged" | "unstaged"): void => {
      if (!file) return;
      rightPanelEvents.emit("open-git-diff", {
        repoPath,
        file,
        staged: section === "staged",
      });
      setIsOpen(false);
    },
    [repoPath],
  );

  const handleChangesOpenFile = useCallback(
    (filePath: string, fileName: string): void => {
      rightPanelEvents.emit("open-git-file", { filePath, fileName });
      setIsOpen(false);
    },
    [],
  );

  const handleChangesOpenTerminal = useCallback(
    (cwd: string): void => {
      if (onOpenTerminal) {
        onOpenTerminal(cwd);
      } else {
        rightPanelEvents.emit("open-terminal-command", { cwd, command: "" });
      }
      setIsOpen(false);
    },
    [onOpenTerminal],
  );

  /** 单个分支项右键菜单 */
  const buildBranchItemMenuItems = (
    branch: GitBranchType,
  ): ContextMenuItem[] => {
    const isOtherWorktree = isOtherWorktreePath(branch.worktreePath);
    const worktreeFolder = branch.worktreePath
      ? getFolderName(branch.worktreePath)
      : null;

    const items: ContextMenuItem[] = [
      {
        id: "copy-branch-name",
        label: t("git.copyBranchName", { defaultValue: "复制分支名称" }),
        icon: <Copy size={13} strokeWidth={1.8} />,
        onClick: () => {
          setBranchItemContextMenu(null);
          void window.snow.writeClipboardText(branch.name).catch(() => {});
        },
      },
    ];

    if (branch.worktreePath) {
      items.push({
        id: "copy-worktree-path",
        label: t("git.copyWorktreePath", { defaultValue: "复制工作树路径" }),
        icon: <FolderGit2 size={13} strokeWidth={1.8} />,
        onClick: () => {
          setBranchItemContextMenu(null);
          void window.snow
            .writeClipboardText(branch.worktreePath!)
            .catch(() => {});
        },
      });
      if (onOpenTerminal) {
        items.push({
          id: "open-worktree-terminal",
          label: t("git.openTerminal", { defaultValue: "在此工作树打开终端" }),
          icon: <Terminal size={13} strokeWidth={1.8} />,
          onClick: () => {
            setBranchItemContextMenu(null);
            onOpenTerminal(branch.worktreePath!);
          },
        });
      }
    }

    if (!branch.isRemote) {
      items.push({
        id: "checkout-branch",
        separator: true,
        label: branch.isCurrent
          ? t("git.currentBranch", { defaultValue: "当前分支" })
          : isOtherWorktree
            ? `${t("git.worktreeCheckedOut", { defaultValue: "已在工作树检出" })}: ${worktreeFolder}`
            : t("git.checkoutBranch", { defaultValue: "切换至该分支" }),
        icon: isOtherWorktree ? (
          <FolderGit2 size={13} strokeWidth={1.8} />
        ) : (
          <GitBranch size={13} strokeWidth={1.8} />
        ),
        disabled:
          branch.isCurrent ||
          isOtherWorktree ||
          management.busy ||
          management.sessionRunning,
        onClick: () => {
          setBranchItemContextMenu(null);
          handleCheckout(branch);
        },
      });
    }

    return [
      ...items,
      ...management.menuItems(branch, () => setBranchItemContextMenu(null)),
    ];
  };

  /** 外层按钮右键菜单 */
  const buildMenuItems = (): ContextMenuItem[] => [
    {
      id: "copy-branch",
      label: t("git.copyBranchName", { defaultValue: "复制分支名称" }),
      icon: <Copy size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        void window.snow.writeClipboardText(currentBranch).catch(() => {});
      },
    },
    {
      id: "create-branch",
      separator: true,
      label: t("git.createBranch", { defaultValue: "新建分支..." }),
      icon: <GitBranchPlus size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        setIsOpen(true);
        setCreateMode("branch");
      },
    },
    ...(currentBranch && currentBranch !== "HEAD"
      ? management.menuItems(
          {
            name: currentBranch,
            isCurrent: true,
            isRemote: false,
            remoteName: null,
          },
          () => setContextMenu(null),
        )
      : []),
    ...(directoryId
      ? [
          {
            id: "create-worktree",
            label: t("git.createWorktree", {
              defaultValue: "新建工作树 (Worktree)...",
            }),
            icon: <FolderGit2 size={13} strokeWidth={1.8} />,
            onClick: () => {
              setContextMenu(null);
              setIsOpen(true);
              setCreateMode("worktree");
            },
          },
        ]
      : []),
    {
      id: "refresh-branches",
      separator: true,
      label: t("git.refreshBranches", { defaultValue: "刷新分支与工作树" }),
      icon: <RefreshCw size={13} strokeWidth={1.8} />,
      onClick: () => {
        setContextMenu(null);
        loadBranches();
        loadWorktrees();
      },
    },
  ];

  /**
   * 下拉层右键：输入框统一弹通用编辑菜单；其余区域拦下事件，
   * 避免冒泡到 TopBar 容器弹出项目菜单。
   */
  const handleDropdownContextMenu = (event: React.MouseEvent): void => {
    event.stopPropagation();
    const target = resolveEditableTarget(event.target, {
      x: event.clientX,
      y: event.clientY,
    });
    if (!target) {
      return;
    }
    event.preventDefault();
    setContextMenu(null);
    setBranchItemContextMenu(null);
    openEditMenuForElement(target, event.clientX, event.clientY);
  };

  // 错误提示自动在 6 秒后淡出清除
  useEffect(() => {
    if (!createError) return;
    const timer = setTimeout(() => {
      setCreateError(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [createError]);

  const normalizedSearch = useMemo(
    () => searchQuery.trim().toLowerCase(),
    [searchQuery],
  );

  // 过滤工作树 (基于已缓存的规范化搜索词)
  const filteredWorktrees = useMemo(() => {
    if (!worktrees.length) return [];
    if (!normalizedSearch) return worktrees;
    return worktrees.filter(
      (wt) =>
        (wt.branchName &&
          wt.branchName.toLowerCase().includes(normalizedSearch)) ||
        getFolderName(wt.worktreePath)
          .toLowerCase()
          .includes(normalizedSearch) ||
        wt.worktreePath.toLowerCase().includes(normalizedSearch),
    );
  }, [worktrees, normalizedSearch]);

  // 本地分支与远程分支单次遍历完成分类与检索过滤，避免两遍全量遍历
  const { localBranches, remoteBranches } = useMemo(() => {
    const local: GitBranchType[] = [];
    const remote: GitBranchType[] = [];
    for (let i = 0; i < branches.length; i++) {
      const b = branches[i];
      if (
        normalizedSearch &&
        !b.name.toLowerCase().includes(normalizedSearch)
      ) {
        continue;
      }
      if (b.isRemote) {
        remote.push(b);
      } else {
        local.push(b);
      }
    }
    return { localBranches: local, remoteBranches: remote };
  }, [branches, normalizedSearch]);

  return (
    <div
      className="branch-selector"
      ref={dropdownRef}
      onMouseDown={() => {
        insideMouseDownRef.current = true;
      }}
    >
      <button
        type="button"
        className="branch-selector-btn"
        onClick={() => setIsOpen(!isOpen)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setBranchItemContextMenu(null);
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
        title={`${currentBranch}${
          worktrees.length > 0
            ? ` · ${t("git.worktreeCountSuffix", {
                values: { count: worktrees.length },
              })}`
            : ""
        }`}
      >
        <GitBranch
          size={13}
          strokeWidth={1.8}
          className="branch-selector-main-icon"
        />
        <span className="branch-selector-name">
          {currentBranch || t("git.unknownBranch")}
        </span>
        {worktrees.length > 0 && (
          <span
            className="branch-selector-wt-pill"
            title={t("git.worktreesCountTooltip", {
              values: { count: worktrees.length },
              defaultValue: `当前存在 ${worktrees.length} 个活跃工作树`,
            })}
          >
            <FolderGit2 size={11} strokeWidth={1.8} />
            <span>{worktrees.length}</span>
          </span>
        )}
        <ChevronDown
          size={11}
          strokeWidth={1.8}
          className="branch-selector-arrow"
        />
      </button>

      {isOpen && (
        <div
          className={`branch-dropdown${
            currentTab === "changes" ? " is-changes-tab" : ""
          }`}
          onContextMenu={handleDropdownContextMenu}
          style={
            dropdownWidthCap === null
              ? undefined
              : {
                  minWidth: `${Math.min(dropdownWidthCap, 330)}px`,
                  maxWidth: `${dropdownWidthCap}px`,
                  ...(currentTab === "changes"
                    ? { width: `${dropdownWidthCap}px` }
                    : {}),
                  ...(dropdownAlignRight ? { left: "auto", right: 0 } : {}),
                }
          }
        >
          {showChangesTab && (
            <div className="branch-dropdown-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={currentTab === "branches"}
                className={`branch-dropdown-tab${
                  currentTab === "branches" ? " active" : ""
                }`}
                onClick={() => setActiveTab("branches")}
              >
                <GitBranch size={12} strokeWidth={1.8} />
                <span>{t("git.branchShort", { defaultValue: "分支" })}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={currentTab === "changes"}
                className={`branch-dropdown-tab${
                  currentTab === "changes" ? " active" : ""
                }`}
                onClick={() => setActiveTab("changes")}
              >
                <FileDiff size={12} strokeWidth={1.8} />
                <span>{t("git.changes", { defaultValue: "变更" })}</span>
                {changesCount > 0 && (
                  <span className="branch-group-badge">{changesCount}</span>
                )}
              </button>
            </div>
          )}

          {currentTab === "changes" ? (
            <div className="branch-dropdown-git-pane">
              <GitControl
                repoPath={repoPath}
                directoryId={directoryId ?? undefined}
                onFileSelect={handleChangesFileSelect}
                onOpenFile={handleChangesOpenFile}
                onOpenTerminal={handleChangesOpenTerminal}
              />
            </div>
          ) : (
            <>
              {/* 顶部搜索与快捷创建按钮组 */}
              <div className="branch-dropdown-header-bar">
                <div className="branch-dropdown-search">
                  <Search size={12} className="branch-search-icon" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    className="branch-search-input"
                    placeholder={t("git.searchBranchesOrWorktrees", {
                      defaultValue: "搜索分支或工作树...",
                    })}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && searchQuery) {
                        e.stopPropagation();
                        setSearchQuery("");
                      }
                    }}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="branch-search-clear-btn"
                      onClick={() => setSearchQuery("")}
                      title={t("common.clear", { defaultValue: "清空" })}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>

                <div className="branch-dropdown-header-actions">
                  <button
                    type="button"
                    className={`branch-header-action-btn${createMode === "branch" ? " active" : ""}`}
                    onClick={() => {
                      setCreateError(null);
                      setCreateMode((prev) =>
                        prev === "branch" ? null : "branch",
                      );
                    }}
                    title={t("git.createBranch", { defaultValue: "新建分支" })}
                  >
                    <GitBranchPlus size={12} strokeWidth={1.8} />
                    <span>
                      {t("git.branchShort", { defaultValue: "分支" })}
                    </span>
                  </button>
                  {directoryId && (
                    <button
                      type="button"
                      className={`branch-header-action-btn${createMode === "worktree" ? " active" : ""}`}
                      onClick={() => {
                        setCreateError(null);
                        setCreateMode((prev) =>
                          prev === "worktree" ? null : "worktree",
                        );
                      }}
                      title={t("git.createWorktree", {
                        defaultValue: "新建工作树",
                      })}
                    >
                      <FolderGit2 size={12} strokeWidth={1.8} />
                      <span>
                        {t("git.worktreeShort", { defaultValue: "工作树" })}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {/* 错误提示条 */}
              {createError && (
                <div className="branch-create-error" role="alert">
                  <div className="branch-create-error-content">
                    <AlertCircle
                      size={12}
                      className="branch-create-error-icon shrink-0"
                    />
                    <span
                      className="branch-create-error-text"
                      title={createError}
                    >
                      {createError}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="branch-create-error-close"
                    onClick={() => setCreateError(null)}
                    title={t("common.close", { defaultValue: "关闭提示" })}
                  >
                    <X size={11} />
                  </button>
                </div>
              )}

              {/* 新建分支表单面板 */}
              {createMode === "branch" && (
                <div className="branch-inline-create-box">
                  <div className="branch-inline-create-title">
                    <GitBranchPlus size={13} strokeWidth={1.8} />
                    <span>
                      {t("git.createBranchTitle", {
                        defaultValue: "新建本地分支",
                      })}
                    </span>
                  </div>
                  <div className="branch-create-input-row">
                    <input
                      ref={branchInputRef}
                      type="text"
                      className="branch-create-input"
                      placeholder={t("git.createBranchPlaceholder", {
                        defaultValue: "分支名称 (例如: feature/login)",
                      })}
                      value={newBranchName}
                      onChange={(e) => {
                        setNewBranchName(e.target.value);
                        setCreateError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleCreateBranch();
                        } else if (e.key === "Escape") {
                          setCreateMode(null);
                        }
                      }}
                      disabled={creating}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="branch-create-submit-btn"
                      onClick={handleCreateBranch}
                      disabled={creating || !newBranchName.trim()}
                    >
                      {creating ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        t("common.create", { defaultValue: "创建" })
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* 新建工作树表单面板 */}
              {createMode === "worktree" && directoryId && (
                <div className="branch-inline-create-box branch-inline-worktree-box">
                  <div className="branch-inline-create-title">
                    <FolderGit2 size={13} strokeWidth={1.8} />
                    <span>
                      {t("git.createWorktreeTitle", {
                        defaultValue: "新建独立工作树 (Worktree)",
                      })}
                    </span>
                  </div>
                  <div className="branch-worktree-form-grid">
                    {/* 1. 分支名称：支持快捷前缀与一键智能生成 */}
                    <div className="branch-worktree-form-field">
                      <div className="branch-form-label-row">
                        <label className="branch-form-label">
                          {t("git.worktreeBranchName", {
                            defaultValue: "分支名称",
                          })}
                        </label>
                        <button
                          type="button"
                          className="branch-name-action-btn"
                          onClick={() => handleGenerateBranchName()}
                          title={t("git.worktreeBranchGenerate", {
                            defaultValue: "自动生成唯一分支名称",
                          })}
                        >
                          <Sparkles size={10} />
                          <span>
                            {t("git.worktreeBranchGenerate", {
                              defaultValue: "自动生成",
                            })}
                          </span>
                        </button>
                      </div>

                      {/* 常用前缀快捷选择 Chips */}
                      <div className="branch-prefix-chips">
                        {["feature/", "fix/", "task/", "test/"].map(
                          (prefix) => (
                            <button
                              key={prefix}
                              type="button"
                              className="branch-prefix-chip"
                              onClick={() => handleApplyPrefix(prefix)}
                              title={t("git.worktreeBranchPrefixTooltip", {
                                values: { prefix },
                              })}
                            >
                              {prefix}
                            </button>
                          ),
                        )}
                      </div>

                      <input
                        ref={worktreeInputRef}
                        type="text"
                        className="branch-create-input"
                        placeholder={t("git.worktreeBranchNamePlaceholder")}
                        value={worktreeBranchName}
                        onChange={(e) => {
                          setWorktreeBranchName(e.target.value);
                          setCreateError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleCreateWorktree();
                          } else if (e.key === "Escape") {
                            setCreateMode(null);
                          }
                        }}
                        disabled={creating}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      {branchNameValidationError && (
                        <div className="branch-form-validation-tip">
                          <AlertCircle size={10} />
                          <span>{branchNameValidationError}</span>
                        </div>
                      )}
                    </div>

                    {/* 2. 起始基线：纯点选优先，支持快捷Chips与全量分支下拉 */}
                    <div className="branch-worktree-form-field">
                      <div className="branch-form-label-row">
                        <label className="branch-form-label">
                          {t("git.worktreeBaseRefLabel", {
                            defaultValue: "起始基线 (分叉起点)",
                          })}
                        </label>
                      </div>

                      {/* 快捷推荐 Chips */}
                      <div className="branch-base-ref-chips">
                        <button
                          type="button"
                          className={`branch-base-ref-chip${!isCustomBaseRef && worktreeBaseRef.trim() === "HEAD" ? " active" : ""}`}
                          onClick={() => {
                            setIsCustomBaseRef(false);
                            setWorktreeBaseRef("HEAD");
                          }}
                          title={t("git.worktreeBaseHeadTooltip", {
                            defaultValue:
                              "基于当前分支状态创建，适合延续当前进度",
                          })}
                        >
                          <span>HEAD</span>
                          <span className="branch-base-ref-chip-sub">
                            (
                            {t("git.worktreeCurrentTag", {
                              defaultValue: "当前",
                            })}
                            : {currentBranch || "HEAD"})
                          </span>
                        </button>
                        {defaultMainBranch &&
                          defaultMainBranch !== currentBranch && (
                            <button
                              type="button"
                              className={`branch-base-ref-chip${!isCustomBaseRef && worktreeBaseRef.trim() === defaultMainBranch ? " active" : ""}`}
                              onClick={() => {
                                setIsCustomBaseRef(false);
                                setWorktreeBaseRef(defaultMainBranch);
                              }}
                              title={t("git.worktreeBaseMainTooltip", {
                                defaultValue: "基于主干分支创建，环境纯净独立",
                              })}
                            >
                              <span>{defaultMainBranch}</span>
                              <span className="branch-base-ref-chip-sub">
                                (
                                {t("git.worktreeMainTag", {
                                  defaultValue: "主干",
                                })}
                                )
                              </span>
                            </button>
                          )}
                      </div>

                      {/* 核心基线选择器：美化自定义下拉，完全无 emoji */}
                      <div className="branch-ref-input-wrapper">
                        <WorktreeBaseRefSelect
                          value={worktreeBaseRef}
                          isCustom={isCustomBaseRef}
                          currentBranch={currentBranch}
                          mainBranch={defaultMainBranch}
                          localBranches={allLocalBranchNames}
                          disabled={creating}
                          onSelect={(ref) => {
                            setIsCustomBaseRef(false);
                            setWorktreeBaseRef(ref);
                          }}
                          onSelectCustom={() => {
                            setIsCustomBaseRef(true);
                            setTimeout(
                              () => customRefInputRef.current?.focus(),
                              50,
                            );
                          }}
                        />

                        {/* 仅在用户选择自定义时才展开文本输入 */}
                        {isCustomBaseRef && (
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              marginTop: "2px",
                            }}
                          >
                            <input
                              ref={customRefInputRef}
                              type="text"
                              className="branch-create-input"
                              placeholder={t(
                                "git.worktreeBaseCustomPlaceholder",
                                {
                                  defaultValue:
                                    "输入 Commit Hash、Tag 或远程分支",
                                },
                              )}
                              value={
                                worktreeBaseRef === "HEAD"
                                  ? ""
                                  : worktreeBaseRef
                              }
                              onChange={(e) =>
                                setWorktreeBaseRef(e.target.value)
                              }
                              disabled={creating}
                              spellCheck={false}
                              autoComplete="off"
                            />
                            <button
                              type="button"
                              className="branch-create-cancel-btn"
                              onClick={() => {
                                setIsCustomBaseRef(false);
                                setWorktreeBaseRef("HEAD");
                              }}
                              title={t("git.worktreeBaseHeadTooltip", {
                                defaultValue: "恢复默认 HEAD",
                              })}
                            >
                              HEAD
                            </button>
                          </div>
                        )}
                      </div>

                      {/* 基线作用动态说明卡片 */}
                      <div className="branch-worktree-helper-text">
                        <Info
                          size={11}
                          className="branch-worktree-helper-icon text-blue-400"
                        />
                        <span>{baseRefDescription}</span>
                      </div>
                    </div>
                  </div>
                  <div className="branch-worktree-form-actions">
                    <button
                      type="button"
                      className="branch-create-cancel-btn"
                      onClick={() => setCreateMode(null)}
                      disabled={creating}
                    >
                      {t("common.cancel", { defaultValue: "取消" })}
                    </button>
                    <button
                      type="button"
                      className="branch-create-submit-btn"
                      onClick={handleCreateWorktree}
                      disabled={
                        creating ||
                        !trimmedWorktreeBranchName ||
                        Boolean(branchNameValidationError)
                      }
                    >
                      {creating ? (
                        <>
                          <Loader2 size={12} className="spin" />
                          <span>
                            {t("git.creatingWorktree", {
                              defaultValue: "创建中...",
                            })}
                          </span>
                        </>
                      ) : (
                        t("git.createWorktreeSubmit", {
                          defaultValue: "创建并检出工作树",
                        })
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* 分支与工作树内容列表 */}
              <div className="branch-dropdown-content-scroll">
                {loading ? (
                  <div className="branch-dropdown-loading">
                    <Loader2 size={14} strokeWidth={1.8} className="spin" />
                    <span>{t("git.loading")}</span>
                  </div>
                ) : (
                  <>
                    {/* 1. 活跃工作树分组 (置顶) */}
                    {filteredWorktrees.length > 0 && (
                      <div className="branch-dropdown-group branch-dropdown-group-worktrees">
                        <div className="branch-dropdown-label">
                          <FolderGit2
                            size={12}
                            strokeWidth={1.8}
                            className="branch-group-label-icon"
                          />
                          <span>
                            {t("git.worktreesTitle", {
                              defaultValue: "工作树",
                            })}
                          </span>
                          <span className="branch-group-badge">
                            {filteredWorktrees.length}
                          </span>
                        </div>

                        {filteredWorktrees.map((wt) => {
                          const folderName = getFolderName(wt.worktreePath);
                          const isMain =
                            normPath(wt.worktreePath) ===
                            normPath(wt.repositoryPath);
                          const isCurrent =
                            normPath(wt.worktreePath) === normPath(repoPath) ||
                            (!isMain && wt.branchName === currentBranch);
                          const isCopied = copiedId === wt.worktreeId;

                          return (
                            <div
                              key={wt.worktreeId}
                              className={`branch-dropdown-item branch-dropdown-wt-item${isCurrent ? " active" : ""}${isSessionRunning ? " is-disabled" : ""}`}
                              title={`${formatDisplayPath(wt.worktreePath)}${wt.isDirty ? " · 包含未提交修改" : ""}\n${isSessionRunning ? t("plusMenu.modeLockedRunning", { defaultValue: "会话进行中，暂不可切换模式" }) : t("git.clickToBindWorktree", { defaultValue: "点击为此会话选择该工作树" })}`}
                              onClick={() => handleSelectWorktreeForChat(wt)}
                            >
                              <div className="branch-dropdown-item-left">
                                <span className="branch-wt-folder-badge">
                                  <Folder size={11} strokeWidth={1.8} />
                                  <span>{folderName}</span>
                                </span>
                                <span className="branch-wt-branch-badge">
                                  <GitBranch size={11} strokeWidth={1.8} />
                                  <span className="truncate max-w-[130px]">
                                    {wt.branchName ||
                                      t("git.graphDetachedHead", {
                                        defaultValue: "游离 HEAD",
                                      })}
                                  </span>
                                </span>
                                {isMain && (
                                  <span
                                    className="branch-badge branch-badge-main"
                                    title={t("git.mainWorktreeTooltip", {
                                      defaultValue: "主工作区目录",
                                    })}
                                  >
                                    {t("git.mainDirectory", {
                                      defaultValue: "主目录",
                                    })}
                                  </span>
                                )}
                                {wt.isDirty && (
                                  <span
                                    className="branch-wt-dirty-dot"
                                    title={t("git.worktreeDirtyTooltip", {
                                      defaultValue: "该工作树包含未提交的修改",
                                    })}
                                  />
                                )}
                              </div>

                              <div
                                className="branch-dropdown-item-right branch-wt-actions"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  className="branch-wt-action-btn"
                                  onClick={() =>
                                    handleCopyPath(
                                      wt.worktreeId,
                                      wt.worktreePath,
                                    )
                                  }
                                  title={t("git.copyWorktreePath", {
                                    defaultValue: "复制完整路径",
                                  })}
                                >
                                  {isCopied ? (
                                    <Check
                                      size={11}
                                      className="text-green-500"
                                    />
                                  ) : (
                                    <Copy size={11} />
                                  )}
                                </button>
                                {onOpenTerminal && (
                                  <button
                                    type="button"
                                    className="branch-wt-action-btn"
                                    onClick={() =>
                                      onOpenTerminal(wt.worktreePath)
                                    }
                                    title={t("git.openTerminal", {
                                      defaultValue: "在此工作树打开终端",
                                    })}
                                  >
                                    <Terminal size={11} />
                                  </button>
                                )}
                                {chatContext && (
                                  <button
                                    type="button"
                                    className="branch-wt-action-btn"
                                    onClick={(e) =>
                                      handleStartNewChatInWorktree(e, wt)
                                    }
                                    title={t("git.startNewChatInWorktree", {
                                      defaultValue: "在此工作树开启新会话",
                                    })}
                                  >
                                    <MessageSquarePlus size={11} />
                                  </button>
                                )}
                                {!isMain && (
                                  <button
                                    type="button"
                                    className={`branch-wt-action-btn branch-wt-action-delete${isCurrent || (isSessionRunning && chatContext?.pendingWorktreeId === wt.worktreeId) ? " is-disabled" : ""}`}
                                    disabled={
                                      removingWorktree ||
                                      isCurrent ||
                                      (isSessionRunning &&
                                        chatContext?.pendingWorktreeId ===
                                          wt.worktreeId)
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!isCurrent) {
                                        setRemoveWorktreeTarget(wt);
                                      }
                                    }}
                                    title={
                                      isCurrent
                                        ? t("git.cannotRemoveCurrentWorktree", {
                                            defaultValue:
                                              "当前所在工作树无法删除，请先切换到其他分支或工作树",
                                          })
                                        : isSessionRunning &&
                                            chatContext?.pendingWorktreeId ===
                                              wt.worktreeId
                                          ? t(
                                              "git.cannotRemoveRunningWorktree",
                                              {
                                                defaultValue:
                                                  "当前会话正在运行中，暂不可移除该工作树",
                                              },
                                            )
                                          : t("git.removeWorktree", {
                                              defaultValue: "移除此工作树",
                                            })
                                    }
                                    aria-label={t("git.removeWorktree", {
                                      defaultValue: "移除此工作树",
                                    })}
                                  >
                                    {removingWorktree &&
                                    removeWorktreeTarget?.worktreeId ===
                                      wt.worktreeId ? (
                                      <Loader2
                                        size={11}
                                        className="spin text-red-400"
                                      />
                                    ) : (
                                      <Trash2 size={11} />
                                    )}
                                  </button>
                                )}
                                {isCurrent && (
                                  <span className="branch-dropdown-item-check" />
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* 2. 本地分支分组 */}
                    {localBranches.length > 0 && (
                      <div className="branch-dropdown-group">
                        <div className="branch-dropdown-label">
                          <GitBranch
                            size={12}
                            strokeWidth={1.8}
                            className="branch-group-label-icon"
                          />
                          <span>{t("git.localBranches")}</span>
                          <span className="branch-group-badge">
                            {localBranches.length}
                          </span>
                        </div>

                        {localBranches.map((branch) => {
                          const isOtherWorktree = isOtherWorktreePath(
                            branch.worktreePath,
                          );
                          const worktreeFolder = branch.worktreePath
                            ? getFolderName(branch.worktreePath)
                            : null;
                          const isUpstreamTracking =
                            branch.upstream?.startsWith("upstream/");

                          return (
                            <button
                              key={branch.name}
                              type="button"
                              className={`branch-dropdown-item${branch.isCurrent ? " active" : ""}`}
                              onClick={() => handleCheckout(branch)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu(null);
                                setBranchItemContextMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  branch,
                                });
                              }}
                              title={
                                isOtherWorktree
                                  ? `${branch.name}\n${t("git.worktreeCheckedOut")}: ${formatDisplayPath(branch.worktreePath ?? "")}`
                                  : branch.name
                              }
                            >
                              <div className="branch-dropdown-item-left">
                                <span className="branch-dropdown-item-name">
                                  {branch.name}
                                </span>
                                {isOtherWorktree && (
                                  <span
                                    className="branch-dropdown-item-worktree-badge"
                                    title={formatDisplayPath(
                                      branch.worktreePath ?? "",
                                    )}
                                  >
                                    <FolderGit2 size={11} strokeWidth={1.8} />
                                    {worktreeFolder}
                                  </span>
                                )}
                                {branch.upstream ? (
                                  <span
                                    className={`branch-dropdown-item-tracking${
                                      isUpstreamTracking ? " is-upstream" : ""
                                    }`}
                                    title={
                                      isUpstreamTracking
                                        ? `${t("git.upstreamRemoteTooltip")}: ${branch.upstream}`
                                        : branch.upstream
                                    }
                                  >
                                    → {branch.upstream}
                                  </span>
                                ) : (
                                  <span
                                    className="branch-badge branch-badge-local"
                                    title={t("git.localOnlyBadge")}
                                  >
                                    {t("git.localOnlyBadge")}
                                  </span>
                                )}
                              </div>
                              <div className="branch-dropdown-item-right">
                                {branch.isGone && (
                                  <span
                                    className="branch-badge branch-badge-gone"
                                    title={t("git.goneBadge")}
                                  >
                                    {t("git.goneBadge")}
                                  </span>
                                )}
                                {typeof branch.behind === "number" &&
                                  branch.behind > 0 && (
                                    <span
                                      className="branch-badge branch-badge-behind"
                                      title={t("git.behindTooltip", {
                                        values: { count: branch.behind },
                                      })}
                                    >
                                      ↓{branch.behind}
                                    </span>
                                  )}
                                {typeof branch.ahead === "number" &&
                                  branch.ahead > 0 && (
                                    <span
                                      className="branch-badge branch-badge-ahead"
                                      title={t("git.aheadTooltip", {
                                        values: { count: branch.ahead },
                                      })}
                                    >
                                      ↑{branch.ahead}
                                    </span>
                                  )}
                                {branch.isCurrent && (
                                  <span className="branch-dropdown-item-check" />
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* 3. 远程分支分组 */}
                    {remoteBranches.length > 0 && (
                      <div className="branch-dropdown-group">
                        <div className="branch-dropdown-label">
                          <span>{t("git.remoteBranches")}</span>
                          <span className="branch-group-badge">
                            {remoteBranches.length}
                          </span>
                        </div>
                        {remoteBranches.map((branch) => {
                          const isUpstream = branch.remoteName === "upstream";
                          return (
                            <button
                              key={branch.name}
                              type="button"
                              className={`branch-dropdown-item${branch.isCurrent ? " active" : ""}`}
                              onClick={() => handleCheckout(branch)}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setBranchItemContextMenu({
                                  x: event.clientX,
                                  y: event.clientY,
                                  branch,
                                });
                              }}
                            >
                              <div className="branch-dropdown-item-left">
                                <span className="branch-dropdown-item-name">
                                  {branch.name}
                                </span>
                              </div>
                              <div className="branch-dropdown-item-right">
                                {isUpstream ? (
                                  <span
                                    className="branch-badge branch-badge-upstream"
                                    title={t("git.upstreamRemoteTooltip")}
                                  >
                                    {t("git.upstreamBadge")}
                                  </span>
                                ) : branch.remoteName ? (
                                  <span className="branch-badge branch-badge-remote">
                                    {branch.remoteName}
                                  </span>
                                ) : null}
                                {branch.isCurrent && (
                                  <span className="branch-dropdown-item-check" />
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {branches.length === 0 &&
                      filteredWorktrees.length === 0 && (
                        <div className="branch-dropdown-empty">
                          {t("git.noBranches")}
                        </div>
                      )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {management.dialog}
      {/* 删除工作树确认对话框 */}
      {removeWorktreeTarget && (
        <ConfirmDialog
          open={Boolean(removeWorktreeTarget)}
          title={t("git.removeWorktreeTitle", { defaultValue: "删除工作树" })}
          message={t("git.removeWorktreeConfirmMsg", {
            values: {
              // {{path}} 传目录名而非完整路径：文案改由 i18n 词条提供，避免弹窗里
              // 出现一长串绝对路径（与旧 defaultValue 的展示保持一致）。
              path: getFolderName(removeWorktreeTarget.worktreePath),
              branch: removeWorktreeTarget.branchName || "",
            },
            defaultValue: `确定要移除工作树 ${getFolderName(removeWorktreeTarget.worktreePath)} 吗？本地磁盘目录和未暂存修改将被清理。`,
          })}
          confirmLabel={t("common.delete", { defaultValue: "删除" })}
          cancelLabel={t("common.cancel", { defaultValue: "取消" })}
          isConfirming={removingWorktree}
          variant="danger"
          onConfirm={handleConfirmRemoveWorktree}
          onCancel={() => {
            if (!removingWorktree) {
              setRemoveWorktreeTarget(null);
            }
          }}
        />
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems()}
          onClose={() => setContextMenu(null)}
        />
      )}
      {branchItemContextMenu && (
        <ContextMenu
          x={branchItemContextMenu.x}
          y={branchItemContextMenu.y}
          items={buildBranchItemMenuItems(branchItemContextMenu.branch)}
          onClose={() => setBranchItemContextMenu(null)}
        />
      )}
      {/* 输入框右键：通用编辑菜单 */}
      {editMenu && (
        <EditContextMenu
          menu={editMenu}
          onCommand={runEditCommand}
          onClose={closeEditMenu}
        />
      )}
    </div>
  );
};
