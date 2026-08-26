import {
  BookOpen,
  GitPullRequest,
  ListTodo,
  Loader2,
  MessageSquare,
  Pencil,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TeamTask, WorkspaceDirectoryRecord } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { Modal } from "../../common/Modal";
import type { MainContentView } from "../types";
import { TeamActivity } from "./TeamActivity";
import { TeamMembers } from "./TeamMembers";
import { TeamNotes } from "./TeamNotes";
import { TeamReviews } from "./TeamReviews";
import { TeamSetupView } from "./TeamSetup";
import { TeamAvatar } from "./TeamShared";
import { TeamTasks } from "./TeamTasks";
import { useTeamData, teamLog } from "./useTeamData";
import { memberName, timeAgo } from "./teamUtils";

type TeamTab = "activity" | "tasks" | "reviews" | "notes" | "members";

const TABS: { id: TeamTab; icon: React.JSX.Element; label: string }[] = [
  {
    id: "activity",
    icon: <MessageSquare size={15} strokeWidth={1.8} />,
    label: "动态",
  },
  {
    id: "tasks",
    icon: <ListTodo size={15} strokeWidth={1.8} />,
    label: "任务",
  },
  {
    id: "reviews",
    icon: <GitPullRequest size={15} strokeWidth={1.8} />,
    label: "评审",
  },
  {
    id: "notes",
    icon: <BookOpen size={15} strokeWidth={1.8} />,
    label: "知识",
  },
  { id: "members", icon: <Users size={15} strokeWidth={1.8} />, label: "成员" },
];

export const TeamPanel = ({
  activeDirectory,
  onNavigateToView,
}: {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onNavigateToView: (view: MainContentView) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const workspacePath = activeDirectory?.path ?? "";
  const team = useTeamData(workspacePath);
  const [tab, setTab] = useState<TeamTab>("activity");
  const [reviewPreset, setReviewPreset] = useState<TeamTask | null>(null);
  const [editIdentity, setEditIdentity] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editingIdentity, setEditingIdentity] = useState(false);

  // 诊断：捕获团队面板内未捕获的渲染/运行错误
  useEffect(() => {
    const onError = (event: ErrorEvent): void => {
      teamLog("TeamPanel.windowError", {
        message: event.message,
        stack: event.error?.stack,
      });
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      teamLog("TeamPanel.unhandledRejection", {
        reason:
          event.reason instanceof Error
            ? event.reason.stack
            : String(event.reason),
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const identity = team.identity;
  const myEmail = identity?.email ?? "";

  // 诊断：每次渲染都输出 identity 状态（内联 JSON，不折叠）
  const panelInstanceRef = useRef(
    `tp-${Math.random().toString(36).slice(2, 7)}`,
  );
  teamLog(`TeamPanel.render#${panelInstanceRef.current}`, {
    workspacePath,
    repoPath: team.repoPath,
    identity: identity
      ? {
          isRepo: identity.isRepo,
          hasIdentity: identity.hasIdentity,
          repoPath: identity.repoPath,
          name: identity.name,
        }
      : null,
  });

  // 身份尚未解析完成：先显示加载，避免闪回设置视图/工作台
  if (team.identityResolving) {
    return (
      <div className="team-panel team-setup">
        <div className="team-panel-loading">
          <Loader2 size={22} className="spin" />
          <div className="team-setup-desc">
            {t("team.loading", { defaultValue: "正在加载团队信息…" })}
          </div>
        </div>
      </div>
    );
  }

  // 未就绪：不是 git 仓库或缺少身份 → 进入设置视图
  if (!identity || !identity.isRepo || !identity.hasIdentity) {
    return (
      <TeamSetupView
        identity={identity}
        repoPath={team.repoPath}
        onConfigured={() => {
          // 身份已写入 git config，重新读取即可进入主面板
          void team.refresh();
          void team.sync();
        }}
      />
    );
  }

  const myMember = team.members.find((m) => m.email === myEmail);
  const teamName = activeDirectory?.name || identity.remoteUrl || team.repoPath;

  const myTaskCount = team.tasks.filter(
    (task) => task.assigneeEmail === myEmail && task.status !== "done",
  ).length;
  const myReviewCount = team.reviews.filter(
    (review) => review.reviewerEmail === myEmail && review.status === "pending",
  ).length;

  const openEditIdentity = (): void => {
    setEditName(identity.name);
    setEditEmail(identity.email);
    setEditError(null);
    setEditIdentity(true);
  };

  const saveIdentity = async (): Promise<void> => {
    if (!editName.trim() || !editEmail.trim()) {
      setEditError(
        t("team.setup.errorRequired", { defaultValue: "请输入姓名和邮箱" }),
      );
      return;
    }
    setEditingIdentity(true);
    setEditError(null);
    try {
      await window.snow.teamConfigureIdentity(
        team.repoPath,
        editName.trim(),
        editEmail.trim(),
      );
      setEditIdentity(false);
      await team.refresh();
      void team.sync();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditingIdentity(false);
    }
  };

  const requestReview = (task: TeamTask): void => {
    setReviewPreset(task);
    setTab("reviews");
  };

  const consumeReviewPreset = (): void => setReviewPreset(null);

  const syncInfo = team.syncResult;
  const lastSyncText = team.lastSyncAt
    ? t("team.header.lastSync", {
        defaultValue: "同步于 {{time}}",
        values: { time: timeAgo(team.lastSyncAt) },
      })
    : "";

  return (
    <div className="team-panel">
      <header className="team-panel-header">
        <div className="team-panel-team">
          <TeamAvatar
            name={teamName}
            seed={identity.remoteUrl || teamName}
            size={34}
          />
          <div className="team-panel-team-info">
            <div className="team-panel-team-name" title={teamName}>
              {teamName}
            </div>
            <div className="team-panel-team-sub" title={identity.remoteUrl}>
              {identity.remoteUrl
                ? identity.remoteUrl
                : t("team.header.noRemote", {
                    defaultValue: "本地团队（未配置远端，共享仅限本机）",
                  })}
            </div>
          </div>
        </div>
        <div className="team-panel-header-right">
          <div className="team-panel-sync">
            {team.syncing ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            <span>
              {team.syncing
                ? t("team.header.syncing", { defaultValue: "同步中…" })
                : lastSyncText}
              {syncInfo && (syncInfo.localAhead > 0 || syncInfo.localBehind > 0)
                ? ` (${syncInfo.localAhead}↑ ${syncInfo.localBehind}↓)`
                : ""}
            </span>
          </div>
          <button
            type="button"
            className="team-btn"
            disabled={team.syncing}
            onClick={() => void team.sync()}
            title={t("team.header.syncNow", { defaultValue: "立即同步" })}
          >
            <RefreshCw size={14} />
          </button>
          {team.error ? (
            <span className="team-header-error" title={team.error}>
              {t("team.header.syncError", { defaultValue: "同步异常" })}
            </span>
          ) : null}
          <div className="team-panel-me">
            <TeamAvatar
              name={memberName(team.members, myEmail)}
              seed={myMember?.avatarSeed ?? myEmail}
              size={26}
              online
            />
            <span className="team-panel-me-name">
              {memberName(team.members, myEmail)}
            </span>
            <button
              type="button"
              className="team-btn team-btn-icon"
              onClick={openEditIdentity}
              title={t("team.header.editIdentity", {
                defaultValue: "修改身份",
              })}
            >
              <Pencil size={13} />
            </button>
          </div>
          <button
            type="button"
            className="team-btn team-btn-icon team-panel-close"
            onClick={() => onNavigateToView("chat")}
            title={t("team.header.close", { defaultValue: "关闭团队协作" })}
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="team-panel-body">
        <nav className="team-panel-nav">
          {TABS.map((item) => {
            const count =
              item.id === "tasks"
                ? myTaskCount
                : item.id === "reviews"
                  ? myReviewCount
                  : 0;
            return (
              <button
                type="button"
                key={item.id}
                className={`team-panel-tab${tab === item.id ? " is-active" : ""}`}
                onClick={() => setTab(item.id)}
              >
                {item.icon}
                <span>
                  {t(`team.tabs.${item.id}`, { defaultValue: item.label })}
                </span>
                {count > 0 ? (
                  <span className="team-tab-badge">{count}</span>
                ) : null}
              </button>
            );
          })}
        </nav>
        <section className="team-panel-content">
          {tab === "activity" ? <TeamActivity team={team} /> : null}
          {tab === "tasks" ? (
            <TeamTasks
              team={team}
              directoryId={activeDirectory?.directoryId ?? ""}
              onNavigateToView={onNavigateToView}
              onRequestReview={requestReview}
            />
          ) : null}
          {tab === "reviews" ? (
            <TeamReviews
              team={team}
              presetTask={reviewPreset}
              onPresetTaskConsumed={consumeReviewPreset}
            />
          ) : null}
          {tab === "notes" ? <TeamNotes team={team} /> : null}
          {tab === "members" ? <TeamMembers team={team} /> : null}
        </section>
      </div>

      <Modal
        open={editIdentity}
        title={t("team.header.editIdentity", { defaultValue: "修改身份" })}
        closeLabel={t("common.close", { defaultValue: "关闭" })}
        onClose={() => setEditIdentity(false)}
        footer={
          <>
            {editError ? (
              <span className="team-form-error">{editError}</span>
            ) : null}
            <button
              type="button"
              className="team-btn team-btn-primary"
              disabled={editingIdentity}
              onClick={() => void saveIdentity()}
            >
              {editingIdentity ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Pencil size={15} />
              )}
              {t("team.setup.save", { defaultValue: "保存" })}
            </button>
          </>
        }
      >
        <div className="team-form">
          <p className="team-form-hint">
            {t("team.setup.identityHint", {
              defaultValue: "身份写入仓库本地 git 配置，团队活动以该身份署名。",
            })}
          </p>
          <label className="team-form-label">
            {t("team.setup.name", { defaultValue: "姓名" })}
            <input
              className="team-form-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </label>
          <label className="team-form-label">
            {t("team.setup.email", { defaultValue: "邮箱" })}
            <input
              className="team-form-input"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
            />
          </label>
        </div>
      </Modal>
    </div>
  );
};
