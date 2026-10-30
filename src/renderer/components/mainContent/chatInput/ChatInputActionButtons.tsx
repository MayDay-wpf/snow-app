import { ArrowUp, Check, ChevronUp, Loader2, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { useBusySendBehavior } from "../../../constants/busySendBehavior";
import { useShortcutLabel } from "../../../hooks/useShortcutLabel";
import type { ChatInputViewProps, SendKeyMode } from "./types";

type ChatInputActionButtonsProps = Pick<
  ChatInputViewProps,
  | "value"
  | "isStreaming"
  | "isAborting"
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
  apiConfigs,
  runtimeApiConfig,
  handleAbort,
  handleSend,
  sendKeyMode,
  setSendKeyMode,
}: ChatInputActionButtonsProps): React.JSX.Element => {
  const { t } = useI18n();
  const sendShortcut = useShortcutLabel("sendMessage");
  const { behavior } = useBusySendBehavior();
  const modifier = navigator.userAgent.includes("Mac") ? "Cmd" : "Ctrl";
  const sendTitle =
    isStreaming || isAborting
      ? t("chatInput.busySendHint", {
          values: {
            behavior: t(
              behavior === "steer"
                ? "settings.busySendSteer"
                : "settings.busySendQueue",
            ),
            shortcut: sendKeyMode === "enter" ? "Enter" : `${modifier}+Enter`,
            alternate:
              sendKeyMode === "enter"
                ? `${modifier}+Enter`
                : `${modifier}+Shift+Enter`,
          },
        })
      : sendShortcut
        ? `Send (${sendShortcut})`
        : "Send";
  const stopShortcut = useShortcutLabel("stopGeneration");
  const [isSendKeyMenuOpen, setIsSendKeyMenuOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);

  // 点击组件外部时收起下拉菜单。
  useEffect(() => {
    if (!isSendKeyMenuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (
        groupRef.current &&
        !groupRef.current.contains(event.target as Node)
      ) {
        setIsSendKeyMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [isSendKeyMenuOpen]);

  const sendDisabled =
    !value.trim() || apiConfigs.length === 0 || !runtimeApiConfig;

  const sendKeyModeLabel = (mode: SendKeyMode): string =>
    mode === "enter"
      ? t("chatInput.sendWithEnter", { defaultValue: "按 Enter 键发送消息" })
      : t("chatInput.sendWithCtrlEnter", {
          defaultValue: "按 Ctrl + Enter 键发送消息",
        });

  // 发送行为项：标签 + 说明，说明写清该行为如何处理待发送消息。
  const deliveryModeText = (
    mode: "queue" | "steer",
  ): { label: string; hint: string } =>
    mode === "steer"
      ? {
          label: t("settings.busySendSteer"),
          hint: t("chatInput.busySendSteerDesc"),
        }
      : {
          label: t("settings.busySendQueue"),
          hint: t("chatInput.busySendQueueDesc"),
        };

  return (
    <div className="input-action-buttons">
      {(isStreaming || isAborting) && (
        <button
          className={`abort-btn ${isAborting ? "is-aborting" : ""}`}
          aria-label={
            isAborting
              ? "Stopping generation"
              : stopShortcut
                ? `Stop generating (${stopShortcut})`
                : "Stop generating"
          }
          title={
            isAborting
              ? "Stopping generation"
              : stopShortcut
                ? `Stop generating (${stopShortcut})`
                : "Stop generating"
          }
          // 必须以无参形式调用：handleAbort 实现接受可选的 targetSessionKey，
          // 直接绑定会把 MouseEvent 当作会话 key，导致中断静默失效。
          onClick={() => handleAbort()}
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
          aria-label={sendTitle}
          title={sendTitle}
          onClick={() => handleSend()}
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
            {(isStreaming || isAborting) && (
              <>
                {(["queue", "steer"] as const).map((mode) => {
                  const { label, hint } = deliveryModeText(mode);
                  return (
                    <button
                      key={`delivery-${mode}`}
                      className={`send-key-menu-item has-description${
                        mode === behavior ? " is-active" : ""
                      }`}
                      role="menuitem"
                      disabled={sendDisabled}
                      onClick={() => {
                        handleSend(mode);
                        setIsSendKeyMenuOpen(false);
                      }}
                      type="button"
                    >
                      <span className="send-key-menu-check" aria-hidden="true">
                        {mode === behavior ? <Check size={13} /> : null}
                      </span>
                      <span className="send-key-menu-text">
                        <span>{label}</span>
                        <span className="send-key-menu-hint">{hint}</span>
                      </span>
                    </button>
                  );
                })}
                {/* 分组文字在左、横线填充剩余宽度（与新建下拉菜单一致）。 */}
                <div
                  className="send-key-menu-divider labeled"
                  role="separator"
                  aria-label={t("chatInput.sendKeyMode", {
                    defaultValue: "发送快捷键",
                  })}
                >
                  <span className="send-key-menu-divider-label">
                    {t("chatInput.sendKeyMode", { defaultValue: "发送快捷键" })}
                  </span>
                </div>
              </>
            )}
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
