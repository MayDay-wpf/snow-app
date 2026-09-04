import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";

export type CustomSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type CustomSelectBaseProps = {
  options: CustomSelectOption[];
  disabled?: boolean;
  title?: string;
  /**
   * When true, the dropdown is rendered into `document.body` via a portal and
   * positioned absolutely relative to the trigger button. Use this when the
   * select lives inside a container with `overflow: hidden` or
   * `overflow: auto` (e.g. inside a Modal) so the dropdown is not clipped.
   *
   * Defaults to `false` to preserve the existing in-flow behavior for all
   * current callers.
   */
  portal?: boolean;
  /**
   * Optional custom renderer for each dropdown item (e.g. an icon or a
   * small diagram next to the label). Falls back to the plain label when
   * omitted.
   */
  renderOption?: (option: CustomSelectOption) => React.ReactNode;
  /**
   * When true, a filter input is shown at the top of the dropdown; typing
   * narrows the visible options by label/value (case-insensitive). The
   * filter resets every time the dropdown opens.
   */
  filterable?: boolean;
  /** Placeholder for the filter input (only used when `filterable`). */
  filterPlaceholder?: string;
  /** Empty-state text shown when the filter matches no options. */
  noMatchText?: string;
  /** Trigger label when `multiple` is set and nothing is selected yet. */
  multipleEmptyLabel?: string;
  /**
   * Trigger label for the selected count in `multiple` mode, e.g.
   * `(count) => \`${count} selected\``. Ignored when `multiple` is unset.
   */
  multipleCountLabel?: (count: number) => string;
};

export type CustomSelectProps =
  | (CustomSelectBaseProps & {
      multiple?: false;
      value: string;
      onChange: (value: string) => void;
    })
  | (CustomSelectBaseProps & {
      multiple: true;
      value: string[];
      onChange: (values: string[]) => void;
    });

type DropdownRect = {
  top: number;
  left: number;
  width: number;
};

export function CustomSelect({
  value,
  options,
  onChange,
  multiple = false,
  disabled = false,
  title,
  portal = false,
  renderOption,
  filterable = false,
  filterPlaceholder = "Filter...",
  noMatchText = "No matching options",
  multipleEmptyLabel = "",
  multipleCountLabel,
}: CustomSelectProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [dropdownRect, setDropdownRect] = useState<DropdownRect | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // Reset the filter and focus the input every time the dropdown opens.
  useEffect(() => {
    if (!isOpen || !filterable) return;
    setFilterText("");
    filterInputRef.current?.focus();
  }, [filterable, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Reposition the portal dropdown on resize/scroll while open.
  useEffect(() => {
    if (!isOpen || !portal) return;
    const update = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDropdownRect({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [isOpen, portal]);

  // Initial measurement for portal dropdown.
  useLayoutEffect(() => {
    if (!portal) {
      setDropdownRect(null);
      return;
    }
    if (!isOpen) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDropdownRect({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    });
  }, [isOpen, portal]);

  const selectedValues = multiple
    ? Array.isArray(value)
      ? value
      : []
    : null;
  const selectedOption = multiple
    ? null
    : options.find((opt) => opt.value === value);
  const displayLabel: string = multiple
    ? (selectedValues?.length ?? 0) > 0
      ? (multipleCountLabel?.(selectedValues?.length ?? 0) ??
        `${selectedValues?.length ?? 0} selected`)
      : multipleEmptyLabel
    : (selectedOption?.label ?? String(value));

  const handleSelect = useCallback(
    (
      event: React.MouseEvent<HTMLButtonElement>,
      option: CustomSelectOption
    ) => {
      event.preventDefault();
      event.stopPropagation();
      if (option.disabled) return;
      if (multiple) {
        if (option.value === "") return;
        const current = Array.isArray(value) ? value : [];
        const next = current.includes(option.value)
          ? current.filter((item) => item !== option.value)
          : [...current, option.value];
        (onChange as (values: string[]) => void)(next);
      } else {
        setIsOpen(false);
        (onChange as (value: string) => void)(option.value);
      }
    },
    [multiple, onChange, value]
  );

  const handleTriggerClick = (): void => {
    if (disabled) return;
    setIsOpen((v) => !v);
  };

  const normalizedFilter = filterText.trim().toLowerCase();
  const visibleOptions =
    filterable && normalizedFilter
      ? options.filter(
          (opt) =>
            opt.label.toLowerCase().includes(normalizedFilter) ||
            opt.value.toLowerCase().includes(normalizedFilter)
        )
      : options;

  const dropdownItems = (
    <>
      {filterable ? (
        <input
          ref={filterInputRef}
          className="custom-select-filter"
          onChange={(event) => setFilterText(event.target.value)}
          placeholder={filterPlaceholder}
          value={filterText}
        />
      ) : null}
      {visibleOptions.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`custom-select-item${opt.disabled ? " disabled" : ""}`}
          onClick={(event) => handleSelect(event, opt)}
          disabled={opt.disabled}
        >
          <span>{renderOption ? renderOption(opt) : opt.label}</span>
          {(multiple
            ? selectedValues?.includes(opt.value)
            : opt.value === value) && (
            <Check size={14} className="custom-select-check" />
          )}
        </button>
      ))}
      {visibleOptions.length === 0 ? (
        <div className="custom-select-empty">{noMatchText}</div>
      ) : null}
    </>
  );

  const dropdown = (
    <div className="custom-select-dropdown" ref={dropdownRef}>
      {dropdownItems}
    </div>
  );

  return (
    <div className="custom-select" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="custom-select-trigger"
        onClick={handleTriggerClick}
        disabled={disabled}
        title={title}
      >
        <span className="custom-select-label" title={displayLabel}>
          {displayLabel}
        </span>
        <ChevronDown size={14} />
      </button>
      {portal && dropdownRect
        ? createPortal(
            isOpen && (
              <div
                className="custom-select-dropdown-portal"
                ref={dropdownRef}
                style={{
                  position: "fixed",
                  top: `${dropdownRect.top}px`,
                  left: `${dropdownRect.left}px`,
                  width: `${dropdownRect.width}px`,
                  zIndex: 100000,
                }}
              >
                <div className="custom-select-dropdown">{dropdownItems}</div>
              </div>
            ),
            document.body
          )
        : !portal && isOpen && dropdown}
    </div>
  );
}
