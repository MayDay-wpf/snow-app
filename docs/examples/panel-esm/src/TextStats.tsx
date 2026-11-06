import type { PanelApi } from "./types";

export function TextStats({ api, text }: { api: PanelApi; text: string }) {
  const { React } = api.ui;
  const characters = Array.from(text).length;
  const lines = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length;

  return (
    <dl className="panel-esm-stats">
      <div>
        <dt>{api.t("characters")}</dt>
        <dd>{characters}</dd>
      </div>
      <div>
        <dt>{api.t("lines")}</dt>
        <dd>{lines}</dd>
      </div>
    </dl>
  );
}
