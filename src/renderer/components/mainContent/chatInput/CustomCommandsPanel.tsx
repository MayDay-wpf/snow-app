import { useI18n } from "../../../i18n";
import { Modal } from "../../common/Modal";
import { CustomCommandsManager } from "../../sidebar/customCommands/CustomCommandsManager";

type CustomCommandsPanelProps = {
  open: boolean;
  projectId?: string;
  projectName?: string;
  onClose: () => void;
};

export const CustomCommandsPanel = ({
  open,
  projectId,
  projectName,
  onClose,
}: CustomCommandsPanelProps): React.JSX.Element => {
  const { t } = useI18n();

  return (
    <Modal
      className="custom-commands-modal"
      closeLabel={t("settings.closeCustomCommandsSettings", {
        defaultValue: "Close custom commands settings",
      })}
      closeOnEscape
      description={t("settings.customCommandsSettingsInfo", {
        defaultValue:
          "Define slash commands that send a prompt to the AI or run a shell command.",
      })}
      onClose={onClose}
      open={open}
      size="large"
      title={t("settings.customCommandsTitle", {
        defaultValue: "Custom commands",
      })}
    >
      <CustomCommandsManager projectId={projectId} projectName={projectName} />
    </Modal>
  );
};
