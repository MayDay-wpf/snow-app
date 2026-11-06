// ==UserScript==
// @name         Snow Continue Shortcut
// @version      1.0.0
// @description  Insert a continue request into the chat input on click.
// @snow-target  client
// @snow-view    chat
// @snow-surface chat
// @snow-sandbox true
// @run-at       document-idle
// @grant        none
// ==/UserScript==

const messages = {
  en: { label: "Continue", text: "Please continue." },
  "zh-CN": { label: "继续", text: "请继续。" },
  "zh-TW": { label: "繼續", text: "請繼續。" },
};

function translation() {
  const locale = snow.context.locale;
  if (locale !== "en" && locale !== "zh-CN" && locale !== "zh-TW") {
    throw new Error(`Unsupported Snow locale: ${locale}`);
  }
  return messages[locale];
}

const button = document.createElement("button");
button.type = "button";

function updateLabel(): void {
  const { label } = translation();
  if (button.textContent !== label) button.textContent = label;
}

function insertText(): void {
  // This host action only inserts text. It never sends a message.
  snow.client.insertInputText(translation().text);
}

function mount(): void {
  // Query the stable slot directly; own only this button, never clear the slot.
  const slot = document.querySelector('[data-snow-slot="chat.input.actions"]');
  if (slot) {
    if (button.parentElement !== slot) slot.append(button);
  } else {
    button.remove();
  }
}

const observer = new MutationObserver(mount);
snow.onCleanup(() => {
  observer.disconnect();
  button.removeEventListener("click", insertText);
  button.remove();
});
button.addEventListener("click", insertText);
snow.on("context", updateLabel);
updateLabel();
observer.observe(document.body, { childList: true, subtree: true });
mount();
