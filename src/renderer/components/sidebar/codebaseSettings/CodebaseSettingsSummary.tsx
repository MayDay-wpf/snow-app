import { BrainCircuit, ListOrdered, Network } from "lucide-react";
import { useI18n } from "../../../i18n";
import {
  findModelById,
  type EmbeddingModelConfig,
  type RerankingModelConfig,
} from "../../../constants/codebaseModels";
import type { CodebaseSettings } from "./types";

type CodebaseSettingsSummaryProps = {
  preview: CodebaseSettings;
  lastSaved: CodebaseSettings;
  embeddingModels: EmbeddingModelConfig[];
  rerankingModels: RerankingModelConfig[];
};

export function CodebaseSettingsSummary({
  preview,
  lastSaved,
  embeddingModels,
  rerankingModels,
}: CodebaseSettingsSummaryProps): React.JSX.Element {
  const { t } = useI18n();
  const embeddingLabel =
    findModelById(embeddingModels, preview.embeddingModelId)?.name ??
    t("settings.codebaseEmbeddingModelNone", { defaultValue: "Not selected" });
  const rerankingLabel =
    findModelById(rerankingModels, preview.rerankingModelId)?.name ??
    t("settings.codebaseRerankingModelNone", { defaultValue: "No reranking" });
  const sourceLabel =
    lastSaved.source === "snow-cli"
      ? t("settings.sourceSnowCli", { defaultValue: "Snow CLI" })
      : t("settings.sourceManual", { defaultValue: "Manual" });

  return (
    <div className="api-settings-summary-grid codebase-settings-summary-grid">
      <div className="api-settings-summary-card">
        <BrainCircuit size={15} strokeWidth={1.8} />
        <span>{embeddingLabel}</span>
        <small>
          {t("settings.codebaseEmbeddingModel", {
            defaultValue: "Embedding model",
          })}
        </small>
      </div>
      <div className="api-settings-summary-card">
        <ListOrdered size={15} strokeWidth={1.8} />
        <span>{rerankingLabel}</span>
        <small>
          {t("settings.codebaseRerankingModel", {
            defaultValue: "Reranking model",
          })}
        </small>
      </div>
      <div className="api-settings-summary-card">
        <Network size={15} strokeWidth={1.8} />
        <span>{sourceLabel}</span>
        <small>{t("settings.source", { defaultValue: "Source" })}</small>
      </div>
    </div>
  );
}
