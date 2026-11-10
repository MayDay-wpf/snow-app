import {
  BookOpen,
  ImageUp,
  ListTodo,
  Loader2,
  MessageSquare,
  Pencil,
  RotateCcw,
  Server,
  Settings,
  Trash2,
  Users,
  Vote,
} from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { TeamSettings } from "./TeamSettings";
import { TeamSetupView } from "./TeamSetup";
import { TeamAvatar, TeamErrorNotice } from "./TeamShared";
import { TeamTasks } from "./TeamTasks";
import { TeamTopics } from "./TeamTopics";
import { readAvatarImage } from "./teamAvatarImage";
import { AVATAR_COLORS, isAvatarImage, isCustomAvatarColor } from "./teamUtils";
import { useTeamData, type TeamDirectory } from "./useTeamData";

type TeamTab =
  "activity" | "tasks" | "topics" | "notes" | "members" | "settings";

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
    id: "topics",
    icon: <Vote size={15} strokeWidth={1.8} />,
    labelKey: "team.tabs.topics",
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
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [hostServiceBusy, setHostServiceBusy] = useState(false);
  const clearEditError = useCallback(() => setEditError(null), []);

  const openEditIdentity = useCallback((): void => {
    const currentSeed = team.team?.selfColor ?? "";
    setEditName(team.team?.selfName ?? "");
    setEditColor(
      isCustomAvatarColor(currentSeed) || isAvatarImage(currentSeed)
        ? currentSeed
        : "",
    );
    setEditError(null);
    setEditIdentity(true);
  }, [team.team]);

  const handleAvatarFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      // 立即清空，允许下次选择同一张图片
      event.target.value = "";
      if (!file) {
        return;
      }
      setAvatarBusy(true);
      setEditError(null);
      try {
        setEditColor(await readAvatarImage(file));
      } catch (err) {
        const tooLarge = err instanceof Error && err.message === "too-large";
        setEditError(
          tooLarge
            ? t("team.header.avatarTooLarge", {
                defaultValue: "图片过大，请选择 10MB 以内的图片",
              })
            : t("team.header.avatarReadError", {
                defaultValue: "图片读取失败，请换一张试试",
              }),
        );
      } finally {
        setAvatarBusy(false);
      }
    },
    [t],
  );

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
  // 待我表态：尚未定案且我还没投票的议题
  const myTopicCount = team.topics.filter(
    (topic) =>
      !topic.veto && !topic.votes.some((vote) => vote.peerId === myPeerId),
  ).length;
  // 队长的待审核加入申请：与其它页签一起计入侧边栏的累计红点
  const myJoinRequestCount =
    team.role === "host" ? team.joinRequests.length : 0;

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
              item.id === "activity"
                ? team.activityUnreadCount
                : item.id === "tasks"
                  ? myTaskCount
                  : item.id === "topics"
                    ? myTopicCount
                    : item.id === "members"
                      ? myJoinRequestCount
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
              directoryPath={activeDirectory?.path ?? ""}
              onNavigateToView={onNavigateToView}
            />
          ) : null}
          {tab === "topics" ? <TeamTopics team={team} /> : null}
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
              disabled={savingIdentity || avatarBusy}
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
            {t("team.header.avatar", { defaultValue: "头像" })}
            <div className="team-color-picker">
              <TeamAvatar
                name={editName.trim() || team.team.selfName}
                seed={editColor || team.team.selfPeerId}
                size={34}
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
              <button
                className="team-btn team-btn-accent team-avatar-upload"
                disabled={avatarBusy}
                title={t("team.header.avatarUpload", {
                  defaultValue: "上传图片",
                })}
                type="button"
                onClick={() => avatarInputRef.current?.click()}
              >
                {avatarBusy ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <ImageUp size={14} />
                )}
                {t("team.header.avatarUpload", { defaultValue: "上传图片" })}
              </button>
              {isAvatarImage(editColor) ? (
                <button
                  className="team-btn team-btn-danger team-avatar-upload"
                  title={t("team.header.avatarRemove", {
                    defaultValue: "移除图片",
                  })}
                  type="button"
                  onClick={() => setEditColor("")}
                >
                  <Trash2 size={14} />
                  {t("team.header.avatarRemove", { defaultValue: "移除图片" })}
                </button>
              ) : null}
              <input
                accept="image/*"
                hidden
                ref={avatarInputRef}
                type="file"
                onChange={(e) => void handleAvatarFile(e)}
              />
            </div>
          </div>
          {team.role === "host" ? (
            <p className="team-form-hint has-icon">
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
