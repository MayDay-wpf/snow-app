import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  appleSurfaceTransition,
  useAppleThemeMotion,
} from "../../hooks/useAppleThemeMotion";

export type CustomSelectOption = {
  value: string;
  label: string;
};

type CustomSelectProps = {
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
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
};

type DropdownRect = {
  top: number;
  left: number;
  width: number;
};

export function CustomSelect({
  value,
  options,
  onChange,
  disabled = false,
  portal = false,
  renderOption,
}: CustomSelectProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<DropdownRect | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { enabled: appleMotionEnabled, reducedMotion } = useAppleThemeMotion();
  const transition = appleSurfaceTransition(reducedMotion);

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

  const selectedOption = options.find((opt) => opt.value === value);
  const displayLabel = selectedOption?.label ?? value;

  const handleSelect = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, val: string) => {
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      onChange(val);
    },
    [onChange]
  );

  const handleTriggerClick = (): void => {
    if (disabled) return;
    setIsOpen((v) => !v);
  };

  const dropdownTarget = appleMotionEnabled
    ? reducedMotion
      ? { opacity: 1 }
      : { opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }
    : undefined;
  const dropdownInitial = appleMotionEnabled
    ? reducedMotion
      ? { opacity: 0 }
      : { opacity: 0, scale: 0.98, y: -4, filter: "blur(1px)" }
    : false;
  const dropdownExit = appleMotionEnabled
    ? reducedMotion
      ? { opacity: 0 }
      : { opacity: 0, scale: 0.98, y: -4, filter: "blur(1px)" }
    : undefined;

  const dropdownItems = (
    <>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="custom-select-item"
          onClick={(event) => handleSelect(event, opt.value)}
        >
          <span>{renderOption ? renderOption(opt) : opt.label}</span>
          {opt.value === value && (
            <Check size={14} className="custom-select-check" />
          )}
        </button>
      ))}
    </>
  );

  const dropdown = (
    <motion.div
      animate={dropdownTarget}
      className="custom-select-dropdown"
      exit={dropdownExit}
      initial={dropdownInitial}
      ref={dropdownRef}
      transition={appleMotionEnabled ? transition : undefined}
    >
      {dropdownItems}
    </motion.div>
  );

  return (
    <div className="custom-select" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="custom-select-trigger"
        onClick={handleTriggerClick}
        disabled={disabled}
      >
        <span className="custom-select-label" title={displayLabel}>
          {displayLabel}
        </span>
        <ChevronDown size={14} />
      </button>
      {portal && dropdownRect
        ? createPortal(
            <AnimatePresence
              initial={false}
              onExitComplete={() => {
                if (!isOpen) {
                  setDropdownRect(null);
                }
              }}
            >
              {isOpen && (
                <motion.div
                  animate={dropdownTarget}
                  className="custom-select-dropdown-portal"
                  exit={dropdownExit}
                  initial={dropdownInitial}
                  ref={dropdownRef}
                  style={{
                    position: "fixed",
                    top: `${dropdownRect.top}px`,
                    left: `${dropdownRect.left}px`,
                    width: `${dropdownRect.width}px`,
                    zIndex: 100000,
                  }}
                  transition={appleMotionEnabled ? transition : undefined}
                >
                  <div className="custom-select-dropdown">{dropdownItems}</div>
                </motion.div>
              )}
            </AnimatePresence>,
            document.body
          )
        : !portal && (
            <AnimatePresence initial={false}>
              {isOpen && dropdown}
            </AnimatePresence>
          )}
    </div>
  );
}
