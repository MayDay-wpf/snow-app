import { Clock, Link2, Loader2, Plus, Users, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useI18n } from "../../../i18n";
import { TeamErrorNotice } from "./TeamShared";
import { AVATAR_COLORS } from "./teamUtils";
import type { TeamData, TeamDirectory } from "./useTeamData";

/**
 * 团队入口视图：创建团队（本机成为队长，承载 WebSocket 服务）或通过
 * 邀请链接加入已有团队。团队数据全部存于本机数据库，不依赖 Git。
 */
export const TeamSetupView = ({
  directory,
  team,
}: {
  directory: TeamDirectory | null;
  team: TeamData;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [teamName, setTeamName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [color, setColor] = useState(AVATAR_COLORS[0]);
  const [inviteLink, setInviteLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);

  const submit = async (): Promise<void> => {
    if (!displayName.trim()) {
      setError(t("team.setup.errorName", { defaultValue: "请输入你的昵称" }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        if (!teamName.trim()) {
          setError(
            t("team.setup.errorTeamName", { defaultValue: "请输入团队名称" }),
          );
          return;
        }
        await team.createTeam(teamName.trim(), displayName.trim(), color);
      } else {
        if (!inviteLink.trim()) {
          setError(
            t("team.setup.errorInvite", { defaultValue: "请粘贴邀请链接" }),
          );
          return;
        }
        await team.joinTeam(inviteLink.trim(), displayName.trim(), color);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (team.pendingJoin) {
    return (
      <div className="team-panel team-setup">
        <div className="team-setup-card">
          <span className="team-setup-icon">
            <Clock size={26} strokeWidth={1.6} />
          </span>
          <h2>
            {t("team.setup.pendingTitle", { defaultValue: "等待队长审核" })}
          </h2>
          <p className="team-setup-desc">
            {t("team.setup.pendingDesc", {
              defaultValue:
                "加入申请已提交，队长同意后你会自动加入团队；请保持应用运行。",
            })}
          </p>
          <TeamErrorNotice message={error} onDismiss={clearError} />
          <button
            type="button"
            className="team-btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void team
                .cancelJoin()
                .catch((e: unknown) =>
                  setError(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <X size={15} />}
            {t("team.setup.pendingCancel", { defaultValue: "取消加入" })}
          </button>
        </div>
      </div>
    );
  }

  if (!directory) {
    return (
      <div className="team-panel team-setup">
        <div className="team-setup-card">
          <span className="team-setup-icon">
            <Users size={26} strokeWidth={1.6} />
          </span>
          <h2>{t("team.setup.title", { defaultValue: "团队协作" })}</h2>
          <p className="team-setup-desc">
            {t("team.setup.noProject", {
              defaultValue:
                "请先在侧边栏打开一个项目，即可创建或加入团队协作。",
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="team-panel team-setup">
      <div className="team-setup-card">
        <span className="team-setup-icon">
          <Users size={26} strokeWidth={1.6} />
        </span>
        <h2>{t("team.setup.title", { defaultValue: "团队协作" })}</h2>
        <p className="team-setup-desc">
          {t("team.setup.desc", {
            defaultValue:
              "团队数据保存在本机数据库；队长设备承载实时通讯服务，队员凭邀请链接加入。",
          })}
        </p>

        <div className="team-setup-tabs">
          <button
            type="button"
            className={`team-setup-tab${mode === "create" ? " is-active" : ""}`}
            onClick={() => setMode("create")}
          >
            <Plus size={14} />
            {t("team.setup.create", { defaultValue: "创建团队" })}
          </button>
          <button
            type="button"
            className={`team-setup-tab${mode === "join" ? " is-active" : ""}`}
            onClick={() => setMode("join")}
          >
            <Link2 size={14} />
            {t("team.setup.join", { defaultValue: "加入团队" })}
          </button>
        </div>

        {team.legacyAvailable ? (
          <p className="team-form-hint">
            {t("team.setup.legacy", {
              defaultValue:
                "检测到本项目下旧版（基于 Git）的团队数据，创建团队时会自动导入。",
            })}
          </p>
        ) : null}

        {mode === "create" ? (
          <label className="team-form-label">
            {t("team.setup.teamName", { defaultValue: "团队名称" })}
            <input
              className="team-form-input"
              value={teamName}
              placeholder={t("team.setup.teamNamePlaceholder", {
                defaultValue: "例如：Snow 核心团队",
              })}
              onChange={(e) => setTeamName(e.target.value)}
            />
          </label>
        ) : (
          <label className="team-form-label">
            {t("team.setup.inviteLink", { defaultValue: "邀请链接" })}
            <input
              className="team-form-input"
              value={inviteLink}
              placeholder="snow-team://join?host=...&code=..."
              onChange={(e) => setInviteLink(e.target.value)}
            />
          </label>
        )}

        <label className="team-form-label">
          {t("team.setup.name", { defaultValue: "我的昵称" })}
          <input
            className="team-form-input"
            value={displayName}
            placeholder={t("team.setup.namePlaceholder", {
              defaultValue: "例如：张三",
            })}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>

        <div className="team-form-label">
          {t("team.header.avatarColor", { defaultValue: "头像颜色" })}
          <div className="team-color-picker">
            {AVATAR_COLORS.map((item) => (
              <button
                key={item}
                aria-label={item}
                className={`team-color-swatch${color === item ? " is-active" : ""}`}
                style={{ background: item }}
                title={item}
                type="button"
                onClick={() => setColor(item)}
              />
            ))}
          </div>
        </div>

        <TeamErrorNotice
          message={team.joinRejected}
          onDismiss={team.clearJoinRejected}
        />
        <TeamErrorNotice message={error} onDismiss={clearError} />
        <button
          type="button"
          className="team-btn team-btn-primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? (
            <Loader2 size={15} className="spin" />
          ) : mode === "create" ? (
            <Plus size={15} />
          ) : (
            <Link2 size={15} />
          )}
          {mode === "create"
            ? t("team.setup.createAction", { defaultValue: "创建团队" })
            : t("team.setup.joinAction", { defaultValue: "加入团队" })}
        </button>
      </div>
    </div>
  );
};
