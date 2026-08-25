import { useI18n } from "../../i18n";
import { Modal } from "../common/Modal";
import { FileViewerContent } from "../rightPanel/FileViewerContent";

type FileEditModalProps = {
  open: boolean;
  filePath: string;
  fileName: string;
  isSsh: boolean;
  sshSessionId?: string | null;
  sshWorkspaceRoot?: string;
  sshWorkspaceId?: string | null;
  onClose: () => void;
  /** 在文件所在目录打开终端。 */
  onOpenTerminal?: (cwd: string) => void;
};

/**
 * 快速文件编辑弹窗：资源管理器双击文件时打开的大尺寸编辑器，
 * 复用右侧面板的 FileViewerContent 并自动进入编辑模式。
 */
export function FileEditModal({
  open,
  filePath,
  fileName,
  isSsh,
  sshSessionId,
  sshWorkspaceRoot,
  sshWorkspaceId,
  onClose,
  onOpenTerminal,
}: FileEditModalProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Modal
      open={open}
      title={fileName}
      description={filePath}
      closeLabel={t("common.close", { defaultValue: "Close" })}
      onClose={onClose}
      size="large"
      className="file-edit-modal"
    >
      <FileViewerContent
        filePath={filePath}
        fileName={fileName}
        isSsh={isSsh}
        sshSessionId={sshSessionId}
        sshWorkspaceRoot={sshWorkspaceRoot}
        sshWorkspaceId={sshWorkspaceId ?? undefined}
        initialEditMode
        onOpenTerminal={onOpenTerminal}
      />
    </Modal>
  );
}
