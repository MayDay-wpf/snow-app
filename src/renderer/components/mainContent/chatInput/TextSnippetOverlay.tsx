import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import { Modal } from "../../common/Modal";
import type { TextSnippetOverlayApi } from "./useTextSnippetOverlay";

type TextSnippetOverlayProps = {
  /** useTextSnippetOverlay 返回的状态与操作。 */
  overlay: TextSnippetOverlayApi;
};

/**
 * 片段 chip 的浮层 UI：悬停展示原文预览，点击 chip 打开片段编辑弹窗。
 *
 * 状态由 useTextSnippetOverlay 提供，聊天输入框与提问卡片共用同一份渲染，
 * 避免各处自建浮层；浮层挂到 document.body，调用方放在组件树任意位置即可。
 */
export const TextSnippetOverlay = ({
  overlay,
}: TextSnippetOverlayProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    preview,
    editor,
    setEditor,
    cancelHidePreview,
    scheduleHidePreview,
    saveEditor,
    deleteEditor,
  } = overlay;

  return (
    <>
      {preview &&
        createPortal(
          <div
            className="text-snippet-preview"
            style={{
              left: preview.x,
              top: preview.y,
              transform: "translate(-50%, calc(-100% - 8px))",
            }}
            onMouseEnter={cancelHidePreview}
            onMouseLeave={scheduleHidePreview}
          >
            <pre className="text-snippet-preview-content">
              {preview.content}
            </pre>
          </div>,
          document.body,
        )}
      {editor &&
        createPortal(
          <Modal
            open={true}
            title={t("chatInput.textSnippetEditorTitle")}
            description={t("chatInput.textSnippetEditorDescription", {
              values: { count: editor.content.length },
            })}
            closeLabel={t("common.cancel")}
            onClose={() => setEditor(null)}
            size="large"
            footer={
              <div className="text-snippet-editor-footer">
                <button
                  type="button"
                  className="text-snippet-editor-btn danger"
                  onClick={deleteEditor}
                >
                  {t("common.delete")}
                </button>
                <div className="text-snippet-editor-footer-right">
                  <button
                    type="button"
                    className="text-snippet-editor-btn secondary"
                    onClick={() => setEditor(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="text-snippet-editor-btn primary"
                    onClick={saveEditor}
                  >
                    {t("common.confirm")}
                  </button>
                </div>
              </div>
            }
          >
            <div className="text-snippet-editor-body">
              <textarea
                className="text-snippet-editor-textarea"
                value={editor.content}
                onChange={(event) =>
                  setEditor((prev) =>
                    prev ? { ...prev, content: event.target.value } : prev,
                  )
                }
                rows={16}
              />
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
};
