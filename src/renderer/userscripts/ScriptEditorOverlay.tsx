import { X } from "lucide-react";

import { FileViewerContent } from "../components/rightPanel/FileViewerContent";
import { useI18n } from "../i18n";
import { scriptEditorStore, useScriptEditorStore } from "./scriptEditorStore";

/**
 * 脚本编辑器遮罩页面：铺满主内容区显示（关闭即不保存），
 * 保存成功后由 scriptEditorStore 自动关闭会话。
 */
export function ScriptEditorOverlay(): React.JSX.Element | null {
  const { t } = useI18n();
  const { session } = useScriptEditorStore();

  if (!session) {
    return null;
  }

  const closeLabel = t("common.close", { defaultValue: "Close" });

  return (
    <div
      aria-label={session.title}
      aria-modal="true"
      className="script-editor-overlay"
      role="dialog"
    >
      <div className="script-editor-page">
        <div className="script-editor-header">
          <strong>{session.title}</strong>
          <button
            aria-label={closeLabel}
            className="icon-btn ghost"
            onClick={() => scriptEditorStore.close()}
            title={closeLabel}
            type="button"
          >
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>
        <div className="script-editor-body">
          <FileViewerContent
            key={session.id}
            filePath={session.fileName}
            fileName={session.fileName}
            isSsh={false}
            initialEditMode
            virtualSource={{
              content: session.content,
              initialDirty: session.mode === "new",
              onSave: (content) => scriptEditorStore.save(content),
            }}
          />
        </div>
      </div>
    </div>
  );
}
