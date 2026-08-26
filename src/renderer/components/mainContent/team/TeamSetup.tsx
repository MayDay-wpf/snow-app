import { GitBranch, Loader2, Save } from "lucide-react";
import { useState } from "react";
import type { TeamIdentity } from "../../../../preload";
import { useI18n } from "../../../i18n";

/**
 * 团队身份设置视图：
 * - 当前目录不是 Git 仓库时给出引导
 * - 是仓库但缺少 git user.name/user.email 时，提供表单写入仓库本地配置
 *   （这就是"基于 Git 的用户系统"——不引入任何独立账号体系）。
 */
export const TeamSetupView = ({
  identity,
  repoPath,
  onConfigured,
}: {
  identity: TeamIdentity | null;
  repoPath: string;
  onConfigured: (identity: TeamIdentity) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notRepo = identity !== null && !identity.isRepo;

  if (!repoPath) {
    return (
      <div className="team-panel team-setup">
        <div className="team-setup-card">
          <span className="team-setup-icon">
            <GitBranch size={26} strokeWidth={1.6} />
          </span>
          <h2>{t("team.setup.title", { defaultValue: "团队协作" })}</h2>
          <p className="team-setup-desc">
            {t("team.setup.noProject", {
              defaultValue:
                "请先在侧边栏打开或添加一个 Git 项目，即可使用基于 Git 的团队协作。",
            })}
          </p>
        </div>
      </div>
    );
  }

  const handleSave = async (): Promise<void> => {
    if (!name.trim() || !email.trim()) {
      setError(
        t("team.setup.errorRequired", { defaultValue: "请输入姓名和邮箱" }),
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await window.snow.teamConfigureIdentity(
        repoPath,
        name.trim(),
        email.trim(),
      );
      onConfigured(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="team-panel team-setup">
      <div className="team-setup-card">
        <span className="team-setup-icon">
          <GitBranch size={26} strokeWidth={1.6} />
        </span>
        <h2>{t("team.setup.title", { defaultValue: "团队协作" })}</h2>

        {notRepo ? (
          <p className="team-setup-desc">
            {t("team.setup.notRepo", {
              defaultValue:
                "当前项目不是 Git 仓库。团队协作基于 Git：身份取自 git config，共享数据存放在仓库的 snow/team 分支上，无需任何后端服务。",
            })}
          </p>
        ) : (
          <>
            <p className="team-setup-desc">
              {t("team.setup.identityHint", {
                defaultValue:
                  "团队身份来自本仓库的 git 配置（user.name / user.email）。填写后将写入仓库本地配置，你的提交与团队活动都会以该身份署名。",
              })}
            </p>
            <label className="team-form-label">
              {t("team.setup.name", { defaultValue: "姓名" })}
              <input
                className="team-form-input"
                value={name}
                placeholder={t("team.setup.namePlaceholder", {
                  defaultValue: "例如：张三",
                })}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="team-form-label">
              {t("team.setup.email", { defaultValue: "邮箱" })}
              <input
                className="team-form-input"
                value={email}
                placeholder={t("team.setup.emailPlaceholder", {
                  defaultValue: "例如：zhangsan@example.com",
                })}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {error ? <div className="team-form-error">{error}</div> : null}
            <button
              type="button"
              className="team-btn team-btn-primary"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Save size={15} />
              )}
              {t("team.setup.save", { defaultValue: "保存并进入团队" })}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
