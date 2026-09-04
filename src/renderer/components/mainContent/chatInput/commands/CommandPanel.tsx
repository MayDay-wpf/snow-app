import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../../../i18n";
import type { ChatCommand } from "./types";

export type CommandPanelHandle = {
  handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => boolean;
};

type CommandPanelProps = {
  commands: ChatCommand[];
  query: string;
  visible: boolean;
  onClose: () => void;
  onSelect: (command: ChatCommand) => void;
};
export const CommandPanel = forwardRef<CommandPanelHandle, CommandPanelProps>(
  function CommandPanel({ commands, query, visible, onClose, onSelect }, ref) {
    const { t } = useI18n();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    const filteredCommands = useMemo(() => {
      const normalizedQuery = query.trim().toLowerCase();
      const matched = !normalizedQuery
        ? commands
        : commands.filter(
            (command) =>
              command.label.toLowerCase().includes(normalizedQuery) ||
              command.description.toLowerCase().includes(normalizedQuery) ||
              command.searchKeywords?.some((keyword) =>
                keyword.toLowerCase().includes(normalizedQuery)
              )
          );

      // 可用的命令排在前面，不可用的统一移到后面集中显示（保持原有相对顺序）
      return [...matched].sort(
        (a, b) => Number(a.disabled) - Number(b.disabled)
      );
    }, [commands, query]);

    useEffect(() => {
      const firstEnabled = filteredCommands.findIndex((c) => !c.disabled);
      setSelectedIndex(firstEnabled === -1 ? 0 : firstEnabled);
    }, [query, visible, filteredCommands]);

    useEffect(() => {
      const list = listRef.current;
      if (!list) return;
      const selectedEl = list.children[selectedIndex] as HTMLElement | undefined;
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest" });
      }
    }, [selectedIndex]);

    useImperativeHandle(
      ref,
      () => ({
        handleKeyDown: (event): boolean => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return true;
          }

          if (filteredCommands.length === 0) {
            return false;
          }

          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelectedIndex((index) => {
              const len = filteredCommands.length;
              for (let i = 1; i <= len; i++) {
                const next = (index + i) % len;
                if (!filteredCommands[next].disabled) return next;
              }
              return index;
            });
            return true;
          }

          if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedIndex((index) => {
              const len = filteredCommands.length;
              for (let i = 1; i <= len; i++) {
                const prev = (index - i + len) % len;
                if (!filteredCommands[prev].disabled) return prev;
              }
              return index;
            });
            return true;
          }

          if (event.key === "Enter") {
            event.preventDefault();
            const command = filteredCommands[selectedIndex];
            if (command && !command.disabled) {
              onSelect(command);
            }
            return true;
          }

          return false;
        },
      }),
      [filteredCommands, onClose, onSelect, selectedIndex]
    );

    return (
      visible && (
        <div
          className="chat-command-panel"
          data-esc-panel
          role="listbox"
          aria-label={t("chatCommand.title")}
        >
        <div className="chat-command-list" ref={listRef}>
          {filteredCommands.length > 0 ? (
            filteredCommands.map((command, index) => {
              const CommandIcon = command.icon;
              const isSelected = index === selectedIndex;

              return (
                <button
                  key={command.id}
                  className={`chat-command-item${
                    isSelected ? " selected" : ""
                  }`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={command.disabled}
                  onMouseEnter={() => {
                    if (!command.disabled) setSelectedIndex(index);
                  }}
                  onClick={() => onSelect(command)}
                >
                  <CommandIcon
                    size={15}
                    strokeWidth={1.8}
                    className="chat-command-item-icon"
                  />
                  <span className="chat-command-item-content">
                    <span className="chat-command-item-name">
                      /{command.label}
                    </span>
                    <span className="chat-command-item-description">
                      {command.description}
                    </span>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="chat-command-empty">{t("chatCommand.empty")}</div>
          )}
        </div>
        <div className="chat-command-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("chatCommand.navigate")}
          </span>
          <span>
            <kbd>Enter</kbd> {t("chatCommand.execute")}
          </span>
          <span>
            <kbd>Esc</kbd> {t("chatCommand.close")}
          </span>
        </div>
        </div>
      )
    );
  }
);
