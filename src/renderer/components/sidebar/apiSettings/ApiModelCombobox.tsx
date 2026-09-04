import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, Loader2, RefreshCw, Search } from "lucide-react";
import { ModelBrandIcon } from "../../common/ModelBrandIcon";
import type { Model } from "../../../../preload";

type ApiModelComboboxProps = {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  models: Model[];
  isLoading: boolean;
  error: string | null;
  hasLoaded: boolean;
  loadingText: string;
  noModelsText: string;
  retryText: string;
  onChange: (value: string) => void;
  onRequestModels: () => void;
  onRetry: () => void;
  /**
   * Optional metadata for known models (alias / preview / deprecated badges).
   * The list item then renders as `id` + alias + badge instead of a plain id.
   */
  knownModels?: Array<{
    id: string;
    alias?: string;
    preview?: boolean;
    deprecated?: boolean;
  }>;
  /** 已知模型徽章文案（如 "预览" / "Preview"）。 */
  previewBadgeText?: string;
  /** 已知模型徽章文案（如 "已弃用" / "Deprecated"）。 */
  deprecatedBadgeText?: string;
};

const MAX_VISIBLE_MODELS = 80;

export function ApiModelCombobox({
  label,
  value,
  placeholder,
  disabled,
  models,
  isLoading,
  error,
  hasLoaded,
  loadingText,
  noModelsText,
  retryText,
  onChange,
  onRequestModels,
  onRetry,
  knownModels,
  previewBadgeText,
  deprecatedBadgeText,
}: ApiModelComboboxProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  // Kept separate from `value`: the input value holds the selected model id,
  // and filtering by it would hide every other model when the list reopens.
  // The keyword only applies to text the user typed since the list was opened.
  const [filterKeyword, setFilterKeyword] = useState("");

  const filteredModels = useMemo(() => {
    const keyword = filterKeyword.trim().toLowerCase();
    const matchedModels = keyword
      ? models.filter((model) => model.id.toLowerCase().includes(keyword))
      : models;

    return matchedModels.slice(0, MAX_VISIBLE_MODELS);
  }, [models, filterKeyword]);

  useEffect(() => {
    // Prefer the currently selected model when it is visible so that
    // reopening the list highlights what is already configured.
    const selectedIndex = filteredModels.findIndex(
      (model) => model.id === value,
    );
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [value, filteredModels]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isOpen]);

  const openModelList = () => {
    if (disabled) {
      return;
    }

    setIsOpen(true);
    onRequestModels();
  };

  // Reopening a closed list must not reuse the previous filter keyword,
  // otherwise the other models stay filtered out and the list looks broken.
  const showFullModelList = () => {
    setFilterKeyword("");
    openModelList();
  };

  const handleSelectModel = (modelId: string) => {
    onChange(modelId);
    setIsOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (isOpen) {
        openModelList();
      } else {
        showFullModelList();
      }
      setHighlightedIndex((index) =>
        Math.min(index + 1, Math.max(filteredModels.length - 1, 0)),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if (event.key === "Enter" && isOpen && filteredModels[highlightedIndex]) {
      event.preventDefault();
      handleSelectModel(filteredModels[highlightedIndex].id);
    }
  };

  const shouldShowEmpty =
    !isLoading && !error && hasLoaded && filteredModels.length === 0;

  return (
    <label className="api-settings-field api-model-combobox-field">
      <span>{label}</span>
      <div className="api-model-combobox" ref={rootRef}>
        <div className="api-model-combobox-input-wrap">
          {value.trim() ? (
            <ModelBrandIcon
              model={value}
              size={14}
              className="api-model-combobox-search"
            />
          ) : (
            <Search size={14} className="api-model-combobox-search" />
          )}
          <input
            value={value}
            onChange={(event) => {
              const nextValue = event.target.value;
              onChange(nextValue);
              setFilterKeyword(nextValue);
              openModelList();
            }}
            onFocus={showFullModelList}
            onClick={showFullModelList}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            role="combobox"
            aria-expanded={isOpen}
            aria-autocomplete="list"
          />
          <span className="api-model-combobox-status" aria-hidden="true">
            {isLoading ? (
              <Loader2 size={14} className="api-model-combobox-spin" />
            ) : (
              <ChevronDown size={14} />
            )}
          </span>
        </div>

        {isOpen && !disabled && (
          <div className="api-model-combobox-menu" role="listbox">
            {isLoading && (
              <div className="api-model-combobox-message">{loadingText}</div>
            )}

            {error && (
              <div className="api-model-combobox-error">
                <span>{error}</span>
                <button type="button" onClick={onRetry} disabled={isLoading}>
                  <RefreshCw size={12} />
                  <span>{retryText}</span>
                </button>
              </div>
            )}

            {!isLoading && !error && filteredModels.length > 0 && (
              <div className="api-model-combobox-list">
                {filteredModels.map((model, index) => {
                  const isSelected = model.id === value;
                  const isHighlighted = index === highlightedIndex;
                  const known = knownModels?.find(
                    (entry) =>
                      entry.id.toLowerCase() === model.id.toLowerCase(),
                  );

                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={`api-model-combobox-option ${
                        isSelected ? "selected" : ""
                      } ${isHighlighted ? "highlighted" : ""}`}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={(event) => {
                        // Prevent the wrapping <label> from forwarding the
                        // click to the input (which would re-open the menu
                        // via onFocus/onClick after the option is unmounted).
                        event.preventDefault();
                        handleSelectModel(model.id);
                      }}
                      role="option"
                      aria-selected={isSelected}
                      title={model.id}
                    >
                      <span className="api-model-combobox-option-main">
                        <ModelBrandIcon
                          model={model.id}
                          size={16}
                          className="api-model-combobox-option-icon"
                        />
                        <span className="api-model-combobox-option-name">
                          {model.id}
                        </span>
                        {known?.alias ? (
                          <span className="api-model-combobox-option-alias">
                            {known.alias}
                          </span>
                        ) : null}
                        {known?.preview ? (
                          <span className="api-model-combobox-badge preview">
                            {previewBadgeText ?? "Preview"}
                          </span>
                        ) : null}
                        {known?.deprecated ? (
                          <span className="api-model-combobox-badge deprecated">
                            {deprecatedBadgeText ?? "Deprecated"}
                          </span>
                        ) : null}
                      </span>
                      {isSelected && <Check size={14} />}
                    </button>
                  );
                })}
              </div>
            )}

            {shouldShowEmpty && (
              <div className="api-model-combobox-message">{noModelsText}</div>
            )}
          </div>
        )}
      </div>
    </label>
  );
}
