import { ArrowUp, Check, ChevronUp, Loader2, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import type { ChatInputViewProps, SendKeyMode } from "./types";

type ChatInputActionButtonsProps = Pick<
  ChatInputViewProps,
  | "value"
  | "isStreaming"
  | "isAborting"
  | "isCompacting"
  | "apiConfigs"
  | "runtimeApiConfig"
  | "handleAbort"
  | "handleSend"
  | "sendKeyMode"
  | "setSendKeyMode"
>;

const SEND_KEY_MODES: SendKeyMode[] = ["enter", "ctrlEnter"];

export const ChatInputActionButtons = ({
  value,
  isStreaming,
  isAborting,
  isCompacting,
  apiConfigs,
  runtimeApiConfig,
  handleAbort,
  handleSend,
  sendKeyMode,
  setSendKeyMode,
}: ChatInputActionButtonsProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isSendKeyMenuOpen, setIsSendKeyMenuOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);

  // 点击组件外部时收起下拉菜单。
  useEffect(() => {
    if (!isSendKeyMenuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (groupRef.current && !groupRef.current.contains(event.target as Node)) {
        setIsSendKeyMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [isSendKeyMenuOpen]);

  const sendDisabled =
    !value.trim() ||
    isCompacting ||
    apiConfigs.length === 0 ||
    !runtimeApiConfig;

  const sendKeyModeLabel = (mode: SendKeyMode): string =>
    mode === "enter"
      ? t("chatInput.sendWithEnter", { defaultValue: "按 Enter 键发送消息" })
      : t("chatInput.sendWithCtrlEnter", {
          defaultValue: "按 Ctrl + Enter 键发送消息",
        });

  return (
    <div className="input-action-buttons">
      {(isStreaming || isAborting) && (
        <button
          className={`abort-btn ${isAborting ? "is-aborting" : ""}`}
          aria-label={isAborting ? "Stopping generation" : "Stop generating"}
          title={isAborting ? "Stopping generation" : "Stop generating"}
          onClick={handleAbort}
          disabled={isAborting}
          type="button"
        >
          {isAborting ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <Square size={14} fill="currentColor" />
          )}
        </button>
      )}
      <div className="send-key-group" ref={groupRef}>
        <button
          className="send-btn"
          aria-label="Send"
          title="Send"
          onClick={handleSend}
          disabled={sendDisabled}
          type="button"
        >
          <ArrowUp size={16} />
        </button>
        <button
          className={`send-key-menu-toggle${
            isSendKeyMenuOpen ? " is-open" : ""
          }`}
          aria-label={t("chatInput.sendKeyMode", {
            defaultValue: "发送快捷键",
          })}
          aria-haspopup="menu"
          aria-expanded={isSendKeyMenuOpen}
          onClick={() => setIsSendKeyMenuOpen((open) => !open)}
          type="button"
        >
          <ChevronUp size={12} />
        </button>
        {isSendKeyMenuOpen && (
          <div className="send-key-menu" role="menu">
            {SEND_KEY_MODES.map((mode) => (
              <button
                key={mode}
                className={`send-key-menu-item${
                  mode === sendKeyMode ? " is-active" : ""
                }`}
                role="menuitemradio"
                aria-checked={mode === sendKeyMode}
                onClick={() => {
                  setSendKeyMode(mode);
                  setIsSendKeyMenuOpen(false);
                }}
                type="button"
              >
                <span className="send-key-menu-check" aria-hidden="true">
                  {mode === sendKeyMode ? <Check size={13} /> : null}
                </span>
                {sendKeyModeLabel(mode)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
