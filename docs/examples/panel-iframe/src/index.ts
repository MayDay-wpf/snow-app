import "./bridge";

// createIframePanel creates this root, loads SnowPlugin, then this script.
// There is no asynchronous bridge-ready event or ESM mount hook here.
const root = document.getElementById("snow-plugin-root");
if (!(root instanceof HTMLElement)) {
  throw new Error("Missing host root: snow-plugin-root");
}
const api = window.SnowPlugin;
document.documentElement.lang = api.locale;

const panel = document.createElement("section");
panel.className = "panel-iframe-draft";
const label = document.createElement("label");
label.htmlFor = "panel-iframe-text";
label.textContent = api.t("draft");
const input = document.createElement("textarea");
input.id = label.htmlFor;
input.spellcheck = false;
const stats = document.createElement("dl");
stats.className = "panel-iframe-stats";
const characterGroup = document.createElement("div");
const characterLabel = document.createElement("dt");
characterLabel.textContent = api.t("characters");
const characters = document.createElement("dd");
characterGroup.append(characterLabel, characters);
const lineGroup = document.createElement("div");
const lineLabel = document.createElement("dt");
lineLabel.textContent = api.t("lines");
const lines = document.createElement("dd");
lineGroup.append(lineLabel, lines);
stats.append(characterGroup, lineGroup);
const clear = document.createElement("button");
clear.type = "button";
clear.textContent = api.t("clear");
panel.append(label, input, stats, clear);
root.replaceChildren(panel);

function updateStats(): void {
  characters.textContent = String(Array.from(input.value).length);
  lines.textContent = String(
    input.value.length === 0 ? 0 : input.value.split(/\r\n|\r|\n/u).length,
  );
  clear.disabled = input.value.length === 0;
}

function clearDraft(): void {
  input.value = "";
  updateStats();
  input.focus();
}

function dispose(): void {
  input.removeEventListener("input", updateStats);
  clear.removeEventListener("click", clearDraft);
  panel.remove();
}

input.addEventListener("input", updateStats);
clear.addEventListener("click", clearDraft);
// The host destroys the iframe document on close/reload; it does not call
// an exported unmount function. Release local handlers when that happens.
window.addEventListener("pagehide", dispose, { once: true });
updateStats();
