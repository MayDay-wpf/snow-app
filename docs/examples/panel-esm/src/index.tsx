import { TextStats } from "./TextStats";
import type { PanelProps } from "./types";

// Classic JSX uses the host React instance, not react/jsx-runtime.
export default function Panel({ api }: PanelProps) {
  const { React } = api.ui;
  const [text, setText] = React.useState("");
  const inputId = React.useId();

  // State and DOM handlers belong to this React instance and are released
  // by the host when it unmounts the component. No module-level state.
  return (
    <section className="panel-esm-draft">
      <label htmlFor={inputId}>{api.t("draft")}</label>
      <textarea
        id={inputId}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        spellCheck={false}
      />
      <TextStats api={api} text={text} />
      <button
        type="button"
        disabled={text.length === 0}
        onClick={() => setText("")}
      >
        {api.t("clear")}
      </button>
    </section>
  );
}
