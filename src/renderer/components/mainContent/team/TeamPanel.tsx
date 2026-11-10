import {
  BookOpen,
  ListTodo,
  Loader2,
  MessageSquare,
  Pencil,
  RotateCcw,
  Server,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceDirectoryRecord } from "../../../../preload";
import { useI18n } from "../../../i18n";
import {
  teamTopBarStore,
  type TeamTopBarSnapshot,
} from "../../TopBar/teamTopBarStore";
import { Modal } from "../../common/Modal";
import type { MainContentView } from "../types";
import { TeamActivity } from "./TeamActivity";
import { TeamMembers } from "./TeamMembers";
import { TeamNotes } from "./TeamNotes";
import { TeamReviews } from "./TeamReviews";
import { TeamSettings } from "./TeamSettings";
import { TeamSetupView } from "./TeamSetup";
import { TeamAvatar, TeamErrorNotice } from "./TeamShared";
import { TeamTasks } from "./TeamTasks";
import { AVATAR_COLORS, isCustomAvatarColor } from "./teamUtils";
import { useTeamData, type TeamDirectory } from "./useTeamData";

type TeamTab =
  "activity" | "tasks" | "reviews" | "notes" | "members" | "settings";

const TABS: { id: TeamTab; icon: React.JSX.Element; labelKey: string }[] = [
  {
    id: "activity",
    icon: <MessageSquare size={15} strokeWidth={1.8} />,
    labelKey: "team.tabs.activity",
  },
  {
    id: "tasks",
    icon: <ListTodo size={15} strokeWidth={1.8} />,
    labelKey: "team.tabs.tasks",
  },
  {
    id: "reviews",
    icon: <ShieldCheck size={15} strokeWidth={1.8} />,
    labelKey: "team.tabs.reviews",
  },
  {
    id: "notes",
    icon: <BookOpen size={15} strokeWidth={1.8} />,
    labelKey: "team.tabs.notes",
  },
  {
    id: "members",
    icon: <Users size={15} strokeWidth={1.8} />,
    labelKey: "team.tabs.members",
  },
];

/** 团队设置页签：仅队长可见（常驻服务 / 邀请链接 / 黑名单）。 */
const SETTINGS_TAB: { id: TeamTab; icon: React.JSX.Element; labelKey: string } =
  {
    id: "settings",
    icon: <Settings size={15} strokeWidth={1.8} />,
    labelKey: "team.tabs.settings",
  };

export const TeamPanel = ({
  activeDirectory,
  onNavigateToView,
}: {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onNavigateToView: (view: MainContentView) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const directory = useMemo<TeamDirectory | null>(
    () =>
      activeDirectory
        ? {
            directoryId: activeDirectory.directoryId,
            path: activeDirectory.path,
          }
        : null,
    [activeDirectory],
  );
  const team = useTeamData(directory);
  const [tab, setTab] = useState<TeamTab>("activity");
  const [editIdentity, setEditIdentity] = useState(false);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [hostServiceBusy, setHostServiceBusy] = useState(false);
  const clearEditError = useCallback(() => setEditError(null), []);

  const openEditIdentity = useCallback((): void => {
    setEditName(team.team?.selfName ?? "");
    setEditColor(
      isCustomAvatarColor(team.team?.selfColor ?? "")
        ? (team.team?.selfColor ?? "")
        : "",
    );
    setEditError(null);
    setEditIdentity(true);
  }, [team.team]);

  const toggleHostService = useCallback(
    (enabled: boolean): void => {
      const teamId = team.team?.teamId;
      if (!teamId) {
        return;
      }
      setHostServiceBusy(true);
      void window.snow
        .teamSetHostService(teamId, enabled)
        .then(() => team.refresh())
        .catch((e: unknown) =>
          setEditError(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => setHostServiceBusy(false));
    },
    [team],
  );

  const topBarSnapshot = useMemo<TeamTopBarSnapshot | null>(() => {
    if (!team.team) {
      return null;
    }
    return {
      teamName: team.team.name,
      role: team.role,
      connected: team.connected,
      endpoint: team.endpoint,
      inviteLink: team.inviteLink,
      error: team.error,
      meName: team.team.selfName,
      meSeed: team.team.selfColor || team.team.selfPeerId,
      hostService: team.team.hostService,
      hostServiceBusy,
      toggleHostService,
      editIdentity: openEditIdentity,
    };
  }, [team, hostServiceBusy, toggleHostService, openEditIdentity]);

  useEffect(() => {
    teamTopBarStore.set(topBarSnapshot);
    return () => teamTopBarStore.set(null);
  }, [topBarSnapshot]);

  if (team.loading && !team.team) {
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

  if (!team.team) {
    return <TeamSetupView directory={directory} team={team} />;
  }

  const myPeerId = team.team.selfPeerId;
  const myTaskCount = team.tasks.filter(
    (task) => task.assigneePeerId === myPeerId && task.status !== "done",
  ).length;
  const myReviewCount = team.reviews.filter(
    (review) =>
      review.reviewerPeerId === myPeerId && review.status === "pending",
  ).length;

  // 团队设置仅队长可见（常驻服务 / 邀请链接 / 黑名单均为队长专属）
  const tabs = team.role === "host" ? [...TABS, SETTINGS_TAB] : TABS;

  const saveIdentity = async (): Promise<void> => {
    if (!editName.trim()) {
      setEditError(
        t("team.setup.errorName", { defaultValue: "请输入你的昵称" }),
      );
      return;
    }
    setSavingIdentity(true);
    setEditError(null);
    try {
      await team.setProfile(editName.trim(), editColor);
      setEditIdentity(false);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingIdentity(false);
    }
  };

  return (
    <div className="team-panel">
      <div className="team-panel-body">
        <nav className="team-panel-nav">
          {tabs.map((item) => {
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
                <span>{t(item.labelKey)}</span>
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
            />
          ) : null}
          {tab === "reviews" ? <TeamReviews team={team} /> : null}
          {tab === "notes" ? <TeamNotes team={team} /> : null}
          {tab === "members" ? <TeamMembers team={team} /> : null}
          {tab === "settings" ? (
            <TeamSettings
              team={team}
              hostServiceBusy={hostServiceBusy}
              onToggleHostService={toggleHostService}
            />
          ) : null}
        </section>
      </div>

      <Modal
        open={editIdentity}
        title={t("team.header.editIdentity", { defaultValue: "修改我的资料" })}
        closeLabel={t("common.close", { defaultValue: "关闭" })}
        onClose={() => setEditIdentity(false)}
        footer={
          <>
            <button
              type="button"
              className="team-btn team-btn-primary"
              disabled={savingIdentity}
              onClick={() => void saveIdentity()}
            >
              {savingIdentity ? (
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
          <label className="team-form-label">
            {t("team.setup.name", { defaultValue: "我的昵称" })}
            <input
              className="team-form-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </label>
          <div className="team-form-label">
            {t("team.header.avatarColor", { defaultValue: "头像颜色" })}
            <div className="team-color-picker">
              <TeamAvatar
                name={editName.trim() || team.team.selfName}
                seed={editColor || team.team.selfPeerId}
                size={26}
              />
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  aria-label={color}
                  className={`team-color-swatch${
                    editColor === color ? " is-active" : ""
                  }`}
                  style={{ background: color }}
                  title={color}
                  type="button"
                  onClick={() => setEditColor(color)}
                />
              ))}
              <button
                aria-label={t("team.header.avatarDefault", {
                  defaultValue: "默认颜色",
                })}
                className={`team-color-default${
                  editColor === "" ? " is-active" : ""
                }`}
                title={t("team.header.avatarDefault", {
                  defaultValue: "默认颜色",
                })}
                type="button"
                onClick={() => setEditColor("")}
              >
                <RotateCcw size={12} />
              </button>
            </div>
          </div>
          {team.role === "host" ? (
            <p className="team-form-hint">
              <Server size={13} />
              {t("team.setup.hostHint", {
                defaultValue:
                  "你是队长：本机承载团队实时服务，关掉窗口后可通过托盘常驻继续在线。",
              })}
            </p>
          ) : null}
        </div>
      </Modal>
      <TeamErrorNotice message={editError} onDismiss={clearEditError} />
    </div>
  );
};
