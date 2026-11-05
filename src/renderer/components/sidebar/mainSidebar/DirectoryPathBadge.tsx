import { FolderX, HardDriveDownload, ShieldAlert } from "lucide-react";

import type { WorkspaceDirectoryRecord } from "../../../../preload";
import { useI18n } from "../../../i18n";

const FAILED_PATH_STATES = new Set([
  "missing",
  "mismatch",
  "offline",
  "permission_error",
]);

/** 路径健康徽标：仅在磁盘校验失败时展示，悬停提示原因与原位置。 */
export function DirectoryPathBadge({
  directory,
}: {
  directory: WorkspaceDirectoryRecord;
}): React.JSX.Element | null {
  const { t } = useI18n();

  // SSH 目录没有本地磁盘路径，不参与路径健康判定
  if (
    directory.kind === "ssh" ||
    !FAILED_PATH_STATES.has(directory.pathState)
  ) {
    return null;
  }

  const badge =
    directory.pathState === "offline"
      ? {
          className: "offline",
          icon: <HardDriveDownload size={11} />,
          label: t("sidebar.directoryPathOffline", {
            defaultValue: "Disk not mounted",
          }),
        }
      : directory.pathState === "permission_error"
        ? {
            className: "permission",
            icon: <ShieldAlert size={11} />,
            label: t("sidebar.directoryPathPermission", {
              defaultValue: "Permission denied",
            }),
          }
        : {
            className: "missing",
            icon: <FolderX size={11} />,
            label: t("sidebar.directoryPathMissing", {
              defaultValue: "Location not found",
            }),
          };

  return (
    <span
      className={`workspace-directory-path-badge ${badge.className}`}
      title={`${badge.label}${
        directory.lastKnownPath ? ` · ${directory.lastKnownPath}` : ""
      }`}
    >
      {badge.icon}
    </span>
  );
}
