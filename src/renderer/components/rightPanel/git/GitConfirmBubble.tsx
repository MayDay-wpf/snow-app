import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CustomSelect } from "../../common/CustomSelect";
import type { GitRemoteInfo } from "../../../../preload";

/** 气泡锚点：触发按钮（或右键菜单点击处）在 viewport 中的位置。 */
export type GitConfirmAnchor = {
  left: number;
  right: number;
  bottom: number;
};

type GitConfirmBubbleProps = {
  anchor: GitConfirmAnchor;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  remotes?: GitRemoteInfo[];
  selectedRemote?: string;
  onSelectRemote?: (remote: string) => void;
  remoteLabel?: string;
  showSetUpstreamOption?: boolean;
  setUpstream?: boolean;
  onToggleSetUpstream?: (checked: boolean) => void;
  setUpstreamLabel?: string;
  confirmDisabled?: boolean;
  /** 自定义气泡宽度，默认按是否含选项自适应。 */
  width?: number;
  /** 确认按钮改用危险色（放弃修改等破坏性操作）。 */
  danger?: boolean;
};

const ARROW_SIZE = 8;
const EDGE_GAP = 6;

/**
 * Git 操作二次确认气泡：portal 渲染在触发按钮下方，箭头指向触发位置；
 * 点击气泡外部或按 Esc 取消。支持多 remote 选择与 set-upstream 勾选。
 */
export function GitConfirmBubble({
  anchor,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  remotes,
  selectedRemote,
  onSelectRemote,
  remoteLabel = "Remote",
  showSetUpstreamOption = false,
  setUpstream = false,
  onToggleSetUpstream,
  setUpstreamLabel = "Set upstream (-u)",
  confirmDisabled = false,
  width,
  danger = false,
}: GitConfirmBubbleProps): React.JSX.Element {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const hasOptions =
    (remotes && remotes.length > 1) ||
    (showSetUpstreamOption && onToggleSetUpstream !== undefined);
  const bubbleWidth = width ?? (hasOptions ? 220 : 168);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && bubbleRef.current?.contains(target)) {
        return;
      }
      onCancel();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCancel();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel]);

  const left = Math.max(
    EDGE_GAP,
    Math.min(
      anchor.right - bubbleWidth,
      window.innerWidth - bubbleWidth - EDGE_GAP,
    ),
  );
  const center = anchor.left + (anchor.right - anchor.left) / 2;
  const arrowLeft = Math.max(
    10,
    Math.min(center - left - ARROW_SIZE / 2, bubbleWidth - 18),
  );

  return createPortal(
    <div
      ref={bubbleRef}
      className={`git-confirm-bubble${hasOptions ? " has-options" : ""}`}
      style={{ left, top: anchor.bottom + EDGE_GAP, width: bubbleWidth }}
      role="tooltip"
    >
      <span
        className="git-confirm-bubble-arrow"
        style={{ left: arrowLeft }}
        aria-hidden="true"
      />
      <span className="git-confirm-bubble-text">{message}</span>
      {remotes && remotes.length > 1 && onSelectRemote && (
        <div className="git-confirm-bubble-remote-row">
          <span className="git-confirm-bubble-remote-label">
            {remoteLabel}:
          </span>
          <div className="git-confirm-bubble-select">
            <CustomSelect
              value={selectedRemote ?? ""}
              options={remotes.map((remote) => ({
                value: remote.name,
                label: remote.name,
              }))}
              onChange={onSelectRemote}
            />
          </div>
        </div>
      )}
      {showSetUpstreamOption && onToggleSetUpstream && (
        <label className="git-confirm-bubble-checkbox-row">
          <input
            type="checkbox"
            checked={setUpstream}
            onChange={(e) => onToggleSetUpstream(e.target.checked)}
          />
          <span>{setUpstreamLabel}</span>
        </label>
      )}
      <div className="git-confirm-bubble-actions">
        <button
          type="button"
          className={`git-confirm-bubble-btn ${danger ? "danger" : "primary"}`}
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="git-confirm-bubble-btn"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      </div>
    </div>,
    document.body,
  );
}
