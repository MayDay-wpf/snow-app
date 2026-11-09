import { AlertCircle, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSkillDefinition } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { Modal } from "../../common/Modal";

type ProjectSkillsPanelProps = {
  open: boolean;
  projectId?: string;
  projectName?: string;
  onClose: () => void;
};

export const ProjectSkillsPanel = ({
  open,
  projectId,
  projectName,
  onClose,
}: ProjectSkillsPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const [skills, setSkills] = useState<ProjectSkillDefinition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSkillIds, setPendingSkillIds] = useState<Set<string>>(
    () => new Set(),
  );
  const loadGenerationRef = useRef(0);
  const pendingSkillGenerationsRef = useRef<Map<string, number>>(new Map());

  const loadSkills = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    pendingSkillGenerationsRef.current.clear();
    setPendingSkillIds(new Set());
    setSkills([]);
    setError(null);

    if (!projectId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const nextSkills = await window.snow.listProjectSkills(projectId);
      if (loadGenerationRef.current === generation) {
        setSkills(nextSkills);
      }
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    if (open) {
      void loadSkills();
      return;
    }

    loadGenerationRef.current += 1;
    pendingSkillGenerationsRef.current.clear();
    setPendingSkillIds(new Set());
    setIsLoading(false);
  }, [loadSkills, open]);

  const toggleSkill = async (
    skill: ProjectSkillDefinition,
    enabled: boolean,
  ): Promise<void> => {
    if (!projectId || pendingSkillGenerationsRef.current.has(skill.id)) {
      return;
    }

    const generation = loadGenerationRef.current;
    const operationProjectId = projectId;
    pendingSkillGenerationsRef.current.set(skill.id, generation);
    setPendingSkillIds((current) => new Set(current).add(skill.id));
    setError(null);
    setSkills((current) =>
      current.map((item) =>
        item.id === skill.id ? { ...item, enabled } : item,
      ),
    );

    try {
      await window.snow.setProjectSkillEnabled(
        operationProjectId,
        skill.id,
        enabled,
      );
    } catch (updateError) {
      if (loadGenerationRef.current === generation) {
        setSkills((current) =>
          current.map((item) =>
            item.id === skill.id ? { ...item, enabled: skill.enabled } : item,
          ),
        );
        setError(
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
        );
      }
    } finally {
      if (pendingSkillGenerationsRef.current.get(skill.id) === generation) {
        pendingSkillGenerationsRef.current.delete(skill.id);
        setPendingSkillIds((current) => {
          const next = new Set(current);
          next.delete(skill.id);
          return next;
        });
      }
    }
  };

  return (
    <Modal
      className="project-sensitive-command-modal project-skills-modal"
      closeLabel={t("projectSkills.close")}
      closeOnEscape
      description={
        projectId
          ? t("projectSkills.description", {
              values: { project: projectName || projectId },
            })
          : t("projectSkills.noProject")
      }
      onClose={onClose}
      open={open}
      size="large"
      title={t("projectSkills.title")}
    >
      {!projectId ? (
        <div className="project-sensitive-command-state">
          <AlertCircle size={18} />
          <span>{t("projectSkills.noProject")}</span>
        </div>
      ) : isLoading && skills.length === 0 ? (
        <div className="project-sensitive-command-state">
          <Loader2 className="spin" size={18} />
          <span>{t("projectSkills.loading")}</span>
        </div>
      ) : (
        <>
          <div className="project-sensitive-command-toolbar">
            <div>
              <span>{t("projectSkills.scopeNote")}</span>
              <small>
                {t("projectSkills.skillCount", {
                  values: { count: skills.length },
                })}
              </small>
            </div>
            <div>
              <button
                className="project-sensitive-command-toolbar-btn"
                disabled={isLoading || pendingSkillIds.size > 0}
                onClick={() => void loadSkills()}
                type="button"
              >
                <RefreshCw className={isLoading ? "spin" : ""} size={14} />
                <span>{t("projectSkills.refresh")}</span>
              </button>
            </div>
          </div>

          {error ? (
            <div className="project-sensitive-command-error">
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          ) : null}

          {skills.length === 0 ? (
            <div className="project-sensitive-command-empty">
              {t("projectSkills.empty")}
            </div>
          ) : (
            <div className="project-sensitive-command-groups project-skills-list">
              {skills.map((skill) => (
                <article
                  className={`project-sensitive-command-row${
                    skill.enabled ? " is-enabled" : ""
                  }`}
                  key={`${skill.id}:${skill.path}`}
                >
                  <Sparkles size={15} />
                  <div className="project-sensitive-command-content">
                    <div>
                      <code>{skill.name || skill.id}</code>
                      <span className="project-sensitive-command-source">
                        {t(`projectSkills.location.${skill.location}`)}
                      </span>
                      <span className="project-sensitive-command-source">
                        {t(`projectSkills.source.${skill.source}`)}
                      </span>
                    </div>
                    <span>{skill.description || "-"}</span>
                    <small className="project-skills-path" title={skill.path}>
                      {skill.path}
                    </small>
                  </div>
                  <label
                    className="toggle-switch"
                    title={
                      skill.enabled
                        ? t("projectSkills.disableForProject")
                        : t("projectSkills.enableForProject")
                    }
                  >
                    <input
                      aria-label={
                        skill.enabled
                          ? t("projectSkills.disableForProject")
                          : t("projectSkills.enableForProject")
                      }
                      checked={skill.enabled}
                      disabled={pendingSkillIds.has(skill.id)}
                      hidden
                      onChange={(event) =>
                        void toggleSkill(skill, event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span className="toggle-slider" />
                  </label>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
};
