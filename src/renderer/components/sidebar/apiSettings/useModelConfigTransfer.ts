import { useCallback, useState } from "react";
import { useI18n } from "../../../i18n";
import type {
  ModelConfigImportOutcome,
  ModelConfigTransferKind,
} from "../../../../preload";

type PendingModelConfigImport = {
  filePath: string;
  totalCount: number;
  conflictNames: string[];
};

type UseModelConfigTransferOptions = {
  kind: ModelConfigTransferKind;
  /** 导入写库后重新加载列表。 */
  onImported: () => Promise<void> | void;
  setStatus: (message: string) => void;
  setError: (message: string) => void;
};

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/** 图像渠道 / 决策 / 嵌入 / 重排表格共用的导出、导入（含同名冲突确认）流程。 */
export function useModelConfigTransfer({
  kind,
  onImported,
  setStatus,
  setError,
}: UseModelConfigTransferOptions) {
  const { t } = useI18n();
  const [isTransferring, setIsTransferring] = useState(false);
  const [pendingImport, setPendingImport] =
    useState<PendingModelConfigImport | null>(null);

  const buildImportStatus = useCallback(
    (outcome: ModelConfigImportOutcome): string => {
      let message = t("settings.modelTransferImportSuccess", {
        defaultValue: "Imported {count} item(s).",
      }).replace("{count}", String(outcome.importedCount));
      if (outcome.overwrittenCount > 0) {
        message += ` ${t("settings.apiImportOverwriteCount", {
          defaultValue: "Overwrote {count} same-name profile(s).",
        }).replace("{count}", String(outcome.overwrittenCount))}`;
      }
      if (outcome.renamedCount > 0) {
        message += ` ${t("settings.apiImportRenamedCount", {
          defaultValue: "Kept {count} as new copies.",
        }).replace("{count}", String(outcome.renamedCount))}`;
      }
      if (outcome.skippedCount > 0) {
        message += ` ${t("settings.apiImportSkippedCount", {
          defaultValue: "Skipped {count} unrecognized entries.",
        }).replace("{count}", String(outcome.skippedCount))}`;
      }
      return message;
    },
    [t],
  );

  const exportSelected = useCallback(
    async (ids: string[]): Promise<void> => {
      setIsTransferring(true);
      setError("");
      setStatus("");
      try {
        const result = await window.snow.exportModelConfigsFile(kind, ids);
        if (result.canceled) {
          return;
        }
        setStatus(
          `${t("settings.modelTransferExportSuccess", {
            defaultValue: "Exported {count} item(s) to {path}.",
          })
            .replace("{count}", String(result.exportedCount))
            .replace("{path}", result.filePath)} ${t(
            "settings.apiExportKeysWarning",
            {
              defaultValue:
                "The exported file contains API keys in plain text. Keep it safe.",
            },
          )}`,
        );
      } catch (error) {
        setError(
          errorText(
            error,
            t("settings.modelTransferExportError", {
              defaultValue: "Failed to export configs",
            }),
          ),
        );
      } finally {
        setIsTransferring(false);
      }
    },
    [kind, setError, setStatus, t],
  );

  const applyImport = useCallback(
    async (
      filePath: string,
      conflictStrategy: "overwrite" | "duplicate",
    ): Promise<void> => {
      setIsTransferring(true);
      setError("");
      setStatus("");
      try {
        const outcome = await window.snow.importModelConfigsFile(
          kind,
          filePath,
          conflictStrategy,
        );
        setPendingImport(null);
        await onImported();
        setStatus(buildImportStatus(outcome));
      } catch (error) {
        setError(
          errorText(
            error,
            t("settings.modelTransferImportError", {
              defaultValue: "Failed to import configs",
            }),
          ),
        );
      } finally {
        setIsTransferring(false);
      }
    },
    [buildImportStatus, kind, onImported, setError, setStatus, t],
  );

  const pickImport = useCallback(async (): Promise<void> => {
    setIsTransferring(true);
    setError("");
    setStatus("");
    let picked: PendingModelConfigImport | null = null;
    try {
      const result = await window.snow.pickModelConfigImportFile(kind);
      if (result.canceled || !result.preview) {
        return;
      }
      picked = {
        filePath: result.filePath,
        totalCount: result.preview.items.length,
        conflictNames: result.preview.conflictNames,
      };
    } catch (error) {
      setError(
        errorText(
          error,
          t("settings.modelTransferImportError", {
            defaultValue: "Failed to import configs",
          }),
        ),
      );
      return;
    } finally {
      setIsTransferring(false);
    }

    // 无冲突直接导入；有冲突交给用户选择覆盖或另存副本。
    if (!picked) {
      return;
    }
    if (picked.conflictNames.length > 0) {
      setPendingImport(picked);
    } else {
      await applyImport(picked.filePath, "overwrite");
    }
  }, [applyImport, kind, setError, setStatus, t]);

  return {
    isTransferring,
    pendingImport,
    exportSelected,
    pickImport,
    resolveImport: (strategy: "overwrite" | "duplicate") =>
      pendingImport ? applyImport(pendingImport.filePath, strategy) : undefined,
    cancelImport: () => setPendingImport(null),
  };
}
