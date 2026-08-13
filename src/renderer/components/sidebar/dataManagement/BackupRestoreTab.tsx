import { Archive, Database, DatabaseBackup, FolderOpen, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";
import type {
  DataManagementBackupRecord,
  DataManagementBackupSettings,
  DataManagementSettings,
  DataManagementSettingsPatch,
  DataManagementState,
} from "../../../../preload";

type BackupRestoreTabProps = {
  state: DataManagementState | null;
  settings: DataManagementSettings | null;
  onUpdateSettings: (patch: DataManagementSettingsPatch) => Promise<void>;
  onCreate: (reason?: string, includeArchive?: boolean) => Promise<unknown | null>;
  onRestore: (path: string) => Promise<boolean>;
  onDelete: (path: string) => Promise<boolean>;
};

export function BackupRestoreTab({
  state,
  settings,
  onUpdateSettings,
  onCreate,
  onRestore,
  onDelete,
}: BackupRestoreTabProps): React.JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [frequency, setFrequency] = useState<"6h" | "12h" | "daily" | "weekly">("daily");
  const [retentionCount, setRetentionCount] = useState(7);
  const [directory, setDirectory] = useState("");
  const [includeArchive, setIncludeArchive] = useState(true);
  const [beforeImport, setBeforeImport] = useState(true);
  const [beforeRestore, setBeforeRestore] = useState(true);
  const [selectingDirectory, setSelectingDirectory] = useState(false);

  const initializedRef = useRef(false);

  useEffect(() => {
    if (!settings || initializedRef.current) return;
    initializedRef.current = true;
    setBackupEnabled(settings.backup.enabled);
    setFrequency(settings.backup.frequency);
    setRetentionCount(settings.backup.retentionCount);
    setDirectory(settings.backup.directory);
    setIncludeArchive(settings.backup.includeArchive);
    setBeforeImport(settings.backup.beforeImport);
    setBeforeRestore(settings.backup.beforeRestore);
  }, [settings]);

  const persistBackup = (patch: Partial<DataManagementBackupSettings>): void => {
    void onUpdateSettings({ backup: patch }).catch(() => {
      // The shared panel displays the error from useDataManagement.
    });
  };

  const toggleBackupEnabled = (checked: boolean): void => {
    setBackupEnabled(checked);
    persistBackup({ enabled: checked });
  };

  const changeFrequency = (value: string): void => {
    const next = value as typeof frequency;
    setFrequency(next);
    persistBackup({ frequency: next });
  };

  const commitRetentionCount = (): void => {
    persistBackup({ retentionCount });
  };

  const commitDirectory = (): void => {
    persistBackup({ directory });
  };

  const selectDirectory = async (): Promise<void> => {
    setSelectingDirectory(true);
    try {
      const selected = await window.snow.selectStorageDirectory(
        t("settings.dataManagementSelectBackupDirectory", {
          defaultValue: "Select backup directory",
        })
      );
      if (selected) {
        setDirectory(selected);
        persistBackup({ directory: selected });
      }
    } catch {
      // The shared panel displays the error from useDataManagement.
    } finally {
      setSelectingDirectory(false);
    }
  };

  const toggleIncludeArchive = (checked: boolean): void => {
    setIncludeArchive(checked);
    persistBackup({ includeArchive: checked });
  };

  const toggleBeforeImport = (checked: boolean): void => {
    setBeforeImport(checked);
    persistBackup({ beforeImport: checked });
  };

  const toggleBeforeRestore = (checked: boolean): void => {
    setBeforeRestore(checked);
    persistBackup({ beforeRestore: checked });
  };

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      await onCreate("manual", includeArchive);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (record: DataManagementBackupRecord): Promise<void> => {
    if (
      !window.confirm(
        t("settings.dataManagementRestoreConfirm", {
          values: { time: new Date(record.createdAt).toLocaleString() },
          defaultValue: "Restore snapshot from {{time}} and restart Snow App?",
        })
      )
    )
      return;
    setBusy(true);
    try {
      await onRestore(record.path);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (record: DataManagementBackupRecord): Promise<void> => {
    if (
      !window.confirm(
        t("settings.dataManagementDeleteConfirm", {
          values: { id: record.id },
          defaultValue: "Delete snapshot {{id}}?",
        })
      )
    )
      return;
    setBusy(true);
    try {
      await onDelete(record.path);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="data-management-tab-content">
      <div className="data-management-hero">
        <div className="data-management-hero-icon">
          <DatabaseBackup size={20} strokeWidth={1.7} />
        </div>
        <div>
          <strong>{t("settings.dataManagementBackupTitle", { defaultValue: "Database snapshots and recovery" })}</strong>
          <p>{t("settings.dataManagementBackupInfo", { defaultValue: "Snapshots use SQLite Online Backup so WAL writes remain consistent while the app is running." })}</p>
        </div>
        <span className="data-management-phase-badge">
          {t("settings.dataManagementSqliteBadge", {
            defaultValue: "SQLite Online Backup",
          })}
        </span>
      </div>

      <section className="data-management-card">
        <div className="data-management-card-heading">
          <ShieldCheck size={16} aria-hidden="true" />
          <strong>{t("settings.dataManagementSnapshotScope", { defaultValue: "Snapshot scope" })}</strong>
        </div>
        <div className="data-management-database-list">
          <div className="data-management-database-row">
            <Database size={15} aria-hidden="true" />
            <div><strong>snowapp.db</strong><span>{t("settings.dataManagementMainDatabase", { defaultValue: "Main application database" })}</span></div>
            <span className="data-management-scope-badge">{t("settings.dataManagementIncluded", { defaultValue: "Included" })}</span>
          </div>
          <div className="data-management-database-row">
            <Archive size={15} aria-hidden="true" />
            <div><strong>archive.db</strong><span>{t("settings.dataManagementArchiveDatabase", { defaultValue: "Archived conversations" })}</span></div>
            <span className="data-management-scope-badge">{t("settings.dataManagementIncluded", { defaultValue: "Included" })}</span>
          </div>
        </div>
      </section>

      <section className="data-management-card">
        <div className="data-management-card-heading"><DatabaseBackup size={16} aria-hidden="true" /><strong>{t("settings.dataManagementAutomaticBackup", { defaultValue: "Automatic backup" })}</strong></div>
        <div className="data-management-form-grid">
          <div className="data-management-checkbox-row">
            <label className="toggle-switch">
              <input type="checkbox" hidden checked={backupEnabled} onChange={(event) => toggleBackupEnabled(event.target.checked)} />
              <span className="toggle-slider" />
            </label>
            <span>{t("settings.dataManagementEnableScheduledSnapshots", { defaultValue: "Enable scheduled snapshots" })}</span>
          </div>
          <label>
            <span>{t("settings.dataManagementFrequency", { defaultValue: "Frequency" })}</span>
            <CustomSelect
              value={frequency}
              options={[
                { value: "6h", label: t("settings.dataManagementEvery6Hours", { defaultValue: "Every 6 hours" }) },
                { value: "12h", label: t("settings.dataManagementEvery12Hours", { defaultValue: "Every 12 hours" }) },
                { value: "daily", label: t("settings.dataManagementDaily", { defaultValue: "Daily" }) },
                { value: "weekly", label: t("settings.dataManagementWeekly", { defaultValue: "Weekly" }) },
              ]}
              onChange={changeFrequency}
            />
          </label>
          <label><span>{t("settings.dataManagementKeepSnapshots", { defaultValue: "Keep snapshots" })}</span><input type="number" min={3} max={100} value={retentionCount} onChange={(event) => setRetentionCount(Math.min(100, Math.max(3, Number(event.target.value) || 3)))} onBlur={commitRetentionCount} /></label>
          <label>
            <span>{t("settings.dataManagementBackupDirectory", { defaultValue: "Backup directory" })}</span>
            <div className="data-management-inline-field">
              <input value={directory} onChange={(event) => setDirectory(event.target.value)} onBlur={commitDirectory} placeholder={t("settings.dataManagementBackupDirectoryPlaceholder", { defaultValue: "Default application backup directory" })} />
              <button
                className="data-management-secondary-button"
                type="button"
                onClick={() => void selectDirectory()}
                disabled={selectingDirectory}
                aria-label={t("settings.dataManagementBrowse", { defaultValue: "Browse" })}
                title={t("settings.dataManagementBrowse", { defaultValue: "Browse" })}
              >
                {selectingDirectory ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <FolderOpen size={14} strokeWidth={1.9} />
                )}
                <span>{t("settings.dataManagementBrowse", { defaultValue: "Browse" })}</span>
              </button>
            </div>
          </label>
        </div>
        <div className="data-management-form-footer data-management-form-footer-start">
          <div className="data-management-checkbox-row">
            <label className="toggle-switch">
              <input type="checkbox" hidden checked={includeArchive} onChange={(event) => toggleIncludeArchive(event.target.checked)} />
              <span className="toggle-slider" />
            </label>
            <span>{t("settings.dataManagementIncludeArchive", { defaultValue: "Include archive.db" })}</span>
          </div>
          <div className="data-management-checkbox-row">
            <label className="toggle-switch">
              <input type="checkbox" hidden checked={beforeImport} onChange={(event) => toggleBeforeImport(event.target.checked)} />
              <span className="toggle-slider" />
            </label>
            <span>{t("settings.dataManagementSafetySnapshotBeforeImport", { defaultValue: "Safety snapshot before import" })}</span>
          </div>
          <div className="data-management-checkbox-row">
            <label className="toggle-switch">
              <input type="checkbox" hidden checked={beforeRestore} onChange={(event) => toggleBeforeRestore(event.target.checked)} />
              <span className="toggle-slider" />
            </label>
            <span>{t("settings.dataManagementSafetySnapshotBeforeRestore", { defaultValue: "Safety snapshot before restore" })}</span>
          </div>
        </div>
        <span className="data-management-muted-note">{t("settings.dataManagementAttachmentNote", { defaultValue: "Attachment files are intentionally not included in this release; database snapshots remain portable and bounded." })}</span>
      </section>

      <div className="data-management-card-grid">
        <section className="data-management-card">
          <div className="data-management-card-heading"><DatabaseBackup size={16} aria-hidden="true" /><strong>{t("settings.dataManagementManualSnapshot", { defaultValue: "Create a snapshot" })}</strong></div>
          <p>{t("settings.dataManagementCreateSnapshotInfo", { defaultValue: "Copies both databases through SQLite Online Backup, checks them, and commits one atomic package." })}</p>
          <button className="data-management-secondary-button" disabled={busy} onClick={() => void create()} type="button">{t("settings.dataManagementCreateSnapshotNow", { defaultValue: "Create snapshot now" })}</button>
        </section>
        <section className="data-management-card">
          <div className="data-management-card-heading"><Archive size={16} aria-hidden="true" /><strong>{t("settings.dataManagementRestore", { defaultValue: "Restore safely" })}</strong></div>
          <p>{t("settings.dataManagementRestoreInfo", { defaultValue: "Restoration is staged and applied before storage initialization after an explicit app restart." })}</p>
          <span className="data-management-muted-note">{state?.activeTask?.phase ?? t("settings.dataManagementSnapshotsAvailable", { values: { count: state?.backups.length ?? 0 }, defaultValue: "{{count}} snapshot(s) available" })}</span>
        </section>
      </div>

      <section className="data-management-card">
        <div className="data-management-card-heading"><strong>{t("settings.dataManagementAvailableSnapshots", { defaultValue: "Available snapshots" })}</strong></div>
        <div className="data-management-backup-list">
          {state?.backups?.length ? state.backups.map((record) => (
            <div className="data-management-backup-row" key={record.path}>
              <div><strong>{new Date(record.createdAt).toLocaleString()}</strong><span>{record.reason} · {(record.sizeBytes / 1024 / 1024).toFixed(1)} MB · {record.integrity}</span></div>
              <div className="data-management-backup-actions">
                <button className="data-management-secondary-button" disabled={busy || record.integrity !== "valid"} onClick={() => void restore(record)} type="button">{t("settings.dataManagementRestoreAction", { defaultValue: "Restore" })}</button>
                <button className="data-management-secondary-button" disabled={busy} onClick={() => void remove(record)} type="button">{t("settings.dataManagementDelete", { defaultValue: "Delete" })}</button>
              </div>
            </div>
          )) : <span className="data-management-muted-note">{t("settings.dataManagementNoSnapshotsYet", { defaultValue: "No snapshots yet." })}</span>}
        </div>
      </section>
    </div>
  );
}
