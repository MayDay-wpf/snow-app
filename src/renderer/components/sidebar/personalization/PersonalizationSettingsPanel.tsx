import { ChevronRight, FolderOpen, Globe, Info } from "lucide-react";
import { useState } from "react";
import type { WorkspaceDirectoryRecord } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { GlobalRoleEditor } from "./GlobalRoleEditor";
import { ProjectRoleEditor } from "./ProjectRoleEditor";

export type PersonalizationSettingsPanelProps = {
  /** 当前激活的工作区项目（项目规则只允许作用于当前项目）。 */
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

/**
 * 个性化/规则设置面板：
 * - 全局规则：编辑 ~/.snow/ROLE.md（对所有项目与对话生效）
 * - 项目规则：编辑当前激活项目的 ROLE.md（本地/SSH），不允许任意切换项目
 * - 默认组合全局与项目规则，并允许项目单独关闭全局规则
 */
export function PersonalizationSettingsPanel({
  activeDirectory,
}: PersonalizationSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [activeScope, setActiveScope] = useState<"global" | "project">(
    "project",
  );

  return (
    <div className="api-settings-page personalization-page" role="region">
      <div className="personalization-workspace">
        <div className="personalization-scope-bar">
          <div className="segmented-tabs" role="tablist">
            <button
              aria-selected={activeScope === "global"}
              className={`segmented-tab${activeScope === "global" ? " active" : ""}`}
              onClick={() => setActiveScope("global")}
              role="tab"
              type="button"
            >
              <Globe size={14} />
              {t("personalization.globalTitle", {
                defaultValue: "Global rules",
              })}
            </button>
            <button
              aria-selected={activeScope === "project"}
              className={`segmented-tab${activeScope === "project" ? " active" : ""}`}
              onClick={() => setActiveScope("project")}
              role="tab"
              type="button"
            >
              <FolderOpen size={14} />
              {t("personalization.projectTitle", {
                defaultValue: "Project rules",
              })}
            </button>
          </div>
          <span className="personalization-scope-summary">
            {t("personalization.scopeSummary", {
              defaultValue:
                "Global + project rules are loaded together by default",
            })}
          </span>
        </div>

        <div
          className="personalization-tabpanel"
          hidden={activeScope !== "global"}
          role="tabpanel"
        >
          <GlobalRoleEditor />
        </div>
        <div
          className="personalization-tabpanel"
          hidden={activeScope !== "project"}
          role="tabpanel"
        >
          <ProjectRoleEditor activeDirectory={activeDirectory} />
        </div>
      </div>

      <section
        className="personalization-rule-chain"
        aria-label={t("personalization.priorityTitle")}
      >
        <div className="personalization-rule-chain-label">
          <Info size={14} />
          <span>
            {t("personalization.loadOrder", { defaultValue: "Load order" })}
          </span>
        </div>
        <div className="personalization-rule-chain-steps">
          <span>
            {t("personalization.priorityGlobal", {
              defaultValue: "Global rules",
            })}
          </span>
          <ChevronRight size={13} />
          <span>
            {t("personalization.priorityProject", {
              defaultValue: "Project rules",
            })}
          </span>
          <ChevronRight size={13} />
          <span>
            {t("personalization.prioritySession", {
              defaultValue: "Conversation instructions",
            })}
          </span>
        </div>
        <small>
          {t("personalization.priorityNote", {
            defaultValue:
              "All enabled scopes are loaded; later instructions take priority only when they conflict.",
          })}
        </small>
      </section>
    </div>
  );
}
