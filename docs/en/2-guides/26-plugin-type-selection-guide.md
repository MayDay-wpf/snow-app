# 26-Plugin architecture and technology-stack selection

> Applies to: Snow App desktop. TypeScript is the default recommendation for new plugins. Choose a stack by runtime boundary first, then apply the panel-versus-client-script rules below. See [24-Plugin development and installation](24-plugin-development-and-installation.md) for manifests, builds and engineering examples, and [22-Userscripts](22-userscripts.md) for the client-script contract.

## Goals

- Choose a TypeScript project and output format that respect the ESM, iframe, OAuth, MCP or client-script runtime boundary;
- Decide whether a requirement means "own a dedicated area inside the app" or "modify the app's existing UI", and pick panel plugins or script plugins accordingly;
- Apply fixed tie-breaking rules in scenarios where both extension types can do the job (composer controls, message-area content), avoiding extensions that break on UI re-render;
- Know the irreplaceable capabilities and permission boundaries of each type, and combine them when necessary.

## Prerequisites

- Extensions are managed on the sidebar **Plugins** page: **Plugin list** contains **Panel plugins**, **OAuth plugins**, **Tool plugins** and **Script plugins** sub-tabs;
- Before writing code, read the matching guide: script plugins in the "Client scripts (desktop window)" section of [22-Userscripts](22-userscripts.md), panel plugins in [24-Plugin development and installation](24-plugin-development-and-installation.md);
- ESM panels and OAuth modules are trusted local code; iframe panels and default client scripts have distinct sandbox boundaries. TypeScript does not change privileges. Only install and author trusted extensions.

## 0. Default stack and engineering boundaries

**Default to strict TypeScript and esbuild, compiling to JavaScript for the chosen runtime.** This is a recommendation for new projects, not a new host stack switch; the host does not execute TypeScript directly. Existing JavaScript plugins and temporary zero-build scripts remain valid. Do not force migrations or add React, Vite or a cross-process framework to every type.

| Type and scenario                                                     | Default recommendation                                    | Runtime boundary and output                                                                                          | Engineering example                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Trusted panel needing host React, input Actions or message/tool slots | TypeScript / TSX, host React and esbuild with classic JSX | One self-contained ESM per entry; host React/icons and separately declared CSS; ESM is not sandboxed                 | [ESM panel manifest](../../examples/panel-esm/plugin.json)                     |
| Independent UI prioritizing isolation when the bridge is sufficient   | TypeScript, native DOM, iframe bridge and esbuild         | One classic IIFE script, not HTML / ESM; use `SnowPlugin`, not the main-window bridge or host React                  | [iframe panel manifest](../../examples/panel-iframe/plugin.json)               |
| Login adapter for a model service                                     | TypeScript, Node target and host OAuth hooks              | One ESM OAuth entry; use `ctx.fetch`; the host owns state, PKCE, callbacks, token persistence and refresh scheduling | [OAuth manifest](../../examples/oauth-provider/plugin.json)                    |
| Explicit external capabilities callable by the Agent                  | TypeScript, Node, MCP SDK, Zod and esbuild                | Separate stdio server and browser-card builds; keep each tool schema beside its handler                              | [MCP tool manifest](../../examples/text-tools/plugin.json)                     |
| Lightweight shortcuts modifying existing host UI                      | TypeScript, native DOM and an esbuild IIFE                | One `.user.js` with a metadata header; sandboxed by default, official slots and `snow.onCleanup`                     | [Client-script build configuration](../../examples/client-script/package.json) |

Choose the capability entry point before the UI. Prefer official structured slots where available, and client scripts only for direct host-UI customization. Choose iframe when isolation matters and the bridge suffices; choose trusted ESM when host React, Actions or slots are required. OAuth and MCP are not UI-framework choices: add a panel only when needed, and never duplicate host login management or tool authorization.

Keep `package.json`, a lockfile, strict `tsconfig.json`, `src/` and `scripts/build.mjs`. Separate runtime contracts, pure business logic and presentation only as far as needed. Declare only consumed host API fields and validate external data at boundaries. Release subscriptions, events, observers and asynchronous work with the corresponding runtime lifecycle. `build` produces the artifacts; `check` checks types and artifact consistency. See [plugin development §5.2](24-plugin-development-and-installation.md#52-typescript-engineering-examples-and-build-flow) for copy, build and installation steps.

## 1. Positioning in one sentence

| Extension type | Positioning                                                                                                                                                        | Typical output                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Panel plugin   | **Own a dedicated area** inside the app: declare panels and let the host provide the container, theme, and localization, while the plugin renders freely inside it | Right-panel tab, composer toolbar entry, message footer card, tool-call card     |
| Script plugin  | **Modify the app's existing UI**: match by view and surface, then use native DOM to restyle, add controls, and hook into the interface                             | UI beautification, shortcut buttons, cross-origin requests, reuse of userscripts |

Their responsibilities differ: panels should operate only on their assigned container and structured slots, while client scripts customize existing UI. Trusted ESM actually has main-window DOM privileges, so that convention is not a security boundary; choose iframe for isolation. Client scripts have neither a panel container nor structured message/tool-slot contracts.

```mermaid
flowchart TD
    A["Extension to build"] --> B{"Does it modify existing UI elements?"}
    B -- "No, only its own UI" --> C["Panel plugin"]
    B -- "Yes" --> D{"Is there an official structured entry point?"}
    D -- "Yes" --> C
    D -- "No" --> E["Script plugin"]
    C --> F{"Multiple panels or localized assets?"}
    F -- "Yes" --> G["Panel plugin directory package"]
    F -- "No" --> H["Panel plugin with a single panel"]
```

## 2. Capability comparison

| Dimension           | Panel plugin                                                                                                                                                                                           | Script plugin (client UI script)                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Form                | Local directory package: `plugin.json` plus an entry file                                                                                                                                              | Single Tampermonkey-compatible file (`// ==UserScript==` header)                                                                                                                     |
| Runtime             | `renderMode: "esm"` runs as an ES module in the main-window renderer; `renderMode: "iframe"` runs in a separate sandbox document                                                                       | Each script gets its own isolated world by default (sandboxed mode); declaring `@snow-sandbox false` or `@grant unsafeWindow` moves it to the page main world (full-permission mode) |
| UI capability       | Declares `panels` to provide panels; `messageFooters` takes over the message footer slot; `toolCallRenderers` takes over external MCP tool cards; `panels[].chatInput` adds a composer toolbar entry   | After matching `@snow-view` / `@snow-surface`, operates on the DOM directly: `data-snow-anchor` anchors are read-only, `data-snow-slot` slots accept mounted nodes                   |
| Host rendering      | ESM panels/contributions use the main React tree; iframe renders in a separate document, uses bridge translations and does not inherit host theme variables                                            | Creates its own nodes; the host only cleans up used slots and `GM_addStyle` styles on unload                                                                                         |
| Data access         | `api.metadata` (37 read-only domains) and `api.write` (225 write actions, authorized per `scope` declaration)                                                                                          | `snow.metadata` / `snow.write`, sharing the same engine and rules as panel plugins, gated by `@snow-privacy`                                                                         |
| Unique capabilities | `api.ai` (ESM only, including prompt optimization and the two-phase safe draft flow), private `api.storage`, `api.assets` resolution, `locales` / `styles` declarations                                | The full `GM_*` set (persisted values, tabs, notifications, clipboard, menu commands), `snow.client` UI actions, zero-build edit-and-reload                                          |
| Network             | `api.net.fetch` (forwarded through the main process, requires the `network` declaration)                                                                                                               | `GM_xmlhttpRequest`, `snow.fetch`; in sandboxed mode the global `fetch` is already replaced by a CORS-free implementation                                                            |
| Distribution        | Directory package (zip as a release asset) or one-click install from the plugin market (official index, plus the community channel that searches third-party repositories by the `snow-plugins` topic) | Single `.user.js` file, installable from a link, also compatible with `kind=script` market entries                                                                                   |
| Storage location    | `~/.snowapp/plugins/<pluginId>/` plus the `app_plugins` table                                                                                                                                          | `~/.snowapp/browser-script/{script_id}.user.js` plus the `userscripts` table (`target` is `client` or `all`)                                                                         |

> Both extension types share one metadata-domain and write-action engine (`api.metadata` with `snow.metadata`, and `api.write` with `snow.write`, both exposing 37 read-only domains and 225 write actions), so data capability is not a selection criterion. UI shape and rendering model are.

## 3. Tie-breaking rules for overlapping scenarios

In the scenarios below either type can work, but cost and stability differ a lot. Follow these rules:

| Requirement                                                                      | Preferred choice                                                 | Rationale                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A persistent composer button or dropdown that must read and write the chat draft | Panel plugin (`panels[].chatInput: true` plus `chatInputAction`) | The action runs inside the main React tree and uses host-managed draft tokens with a confirm / restore flow; scripts can only manipulate composer text        |
| A lightweight composer button that inserts fixed text                            | Script plugin slot `chat.input.actions`                          | Lowest implementation cost, and nodes appended to slots are cleaned up by the host on unload                                                                  |
| Append information under every AI reply                                          | Panel plugin `messageFooters`                                    | An official message-slot contract that mounts correctly with list virtualization; nodes appended by scripts are removed when virtualization rebuilds the list |
| Render a dedicated card for an external MCP tool                                 | Panel plugin `toolCallRenderers`                                 | Script plugins have no such capability                                                                                                                        |
| Call the app's built-in AI optimization                                          | Panel plugin `api.ai` (ESM only)                                 | Script plugins do not expose an `ai` capability                                                                                                               |
| Adjust overall visuals: hide elements, change colors, tune spacing               | Script plugin                                                    | Panels own their container and structured slots; do not use ESM privileges to customize host DOM                                                              |
| Insert simple controls into the top bar, sidebar, or message action row          | Script plugin slots                                              | Single file, zero build, effective immediately on save                                                                                                        |
| Quick experiments, or reuse Tampermonkey ecosystem scripts                       | Script plugin                                                    | Compatible metadata header and `GM_*`, installable directly from a link                                                                                       |
| Multiple panels, multiple locales, separate style files, private storage         | Panel plugin                                                     | The directory package provides `panels` / `locales` / `styles` / `api.storage`                                                                                |

The rule in one line: **wherever an official structured entry point exists, use a panel plugin; where none exists and the host UI must be modified directly, use a script plugin.**

## 4. Scenarios only one type can handle

| Only possible with | Scenario                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel plugin       | Providing an openable panel; taking over message footers and tool-call cards; using the `api.ai` draft confirm flow; declaring locales and style files; using plugin-private storage         |
| Script plugin      | Modifying the app's overall appearance; inserting nodes into arbitrary host anchors / slots; reusing Tampermonkey scripts and `GM_*`; installing a single file without packaging a directory |

## 5. Combining both

Both types can be installed at once and act on the same UI without conflict: script plugins own the presentation layer (layout, visuals, shortcut entries) while panel plugins own the functional layer (data views, write operations, structured cards). When a script plugin needs to show complex data, prefer handing that data to a panel plugin for rendering instead of building a parallel UI inside the script.

## 6. Permission and security boundary comparison

| Dimension         | Panel plugin                                                                                                                                                                   | Script plugin                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default privilege | `esm` equals local renderer code (full privilege); `iframe` is a sandbox document that can only request `metadata` / `write` / `storage` / `assets` / `net` through the bridge | Sandboxed mode runs in an isolated world without `window.snow` or other app privileges; declaring the opt-out promotes it to full-permission mode |
| Data access       | Sensitive domains must be declared in the `privacy` field of `plugin.json`; otherwise access is denied (returns `denied`)                                                      | Sensitive domains must be declared in `@snow-privacy`; otherwise access is denied (returns `denied`)                                              |
| UI isolation      | ESM should use only its own container but has main-window DOM privileges; iframe is isolated in a sandbox document                                                             | Can change host DOM directly; nodes it modifies must be restored by the script in `snow.onCleanup`                                                |
| Failure impact    | An ESM plugin exception bubbles into the host render tree, so plugins should ship their own error boundary                                                                     | Errors are reported and counted; a script is **automatically disabled after 5 consecutive failures**                                              |

When the lowest risk is required, prefer the `iframe` render mode for panel plugins or sandboxed mode for script plugins. Full-permission mode (`esm` panels, main-world scripts) is equivalent to local code, so check the permission badge on the management page before enabling it.

## 7. Verification

1. Panel plugin: after installation, open its panel from the **plus menu** "Plugins" group or the right-panel tab system and confirm data and write operations work; `messageFooters` / `toolCallRenderers` contributions must be observed on the matching message or tool card.
2. Script plugin: after enabling it under **Plugin list → Script plugins**, switch to the view or surface the script declares and observe the UI change; errors are logged with the `[Snow Client Script]` prefix and counted as `errors n` in the list.
3. Confirm the UI recovers after disabling: a disabled panel plugin disappears from the entries, while a disabled script plugin has its slot content, `GM_addStyle` styles, and `snow.onCleanup` callbacks cleaned up by the host.

## 8. Troubleshooting and recovery

| Symptom                                                | Check                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both approaches work and the choice is unclear         | Go back to the rules in section 3: first check whether the target location has an official structured entry point                                                         |
| Nodes modified by a script disappear after a re-render | Expected. Re-attach with a `MutationObserver`, or switch to a panel plugin structured contribution point                                                                  |
| A script stops working after switching views           | Scripts without `@snow-scope global` unload when the view is left; declare `global` to stay resident, or rebuild in `snow.on('view-enter', ...)`                          |
| A sandboxed script cannot read `window.snow`           | Expected behavior; use `snow.metadata` / `snow.write` with an `@snow-privacy` declaration, and only escalate to full-permission mode when raw privilege is truly required |
| A script was disabled automatically                    | Triggered by 5 consecutive failures; fix it and enable it manually again                                                                                                  |
| A panel plugin's panel does not appear                 | Confirm the plugin is enabled and look in the plus menu "Plugins" group; after editing `plugin.json`, use "reload manifest"                                               |

## Implementation anchors

- Panel plugin manifest parsing (`panels` / `messageFooters` / `toolCallRenderers` / `chatInput` contribution points): `src/renderer/plugins/manifest.ts::normalizePanels`, `::normalizeMessageFooters`, `::normalizeToolCallRenderers`
- Panel plugin runtime API (`metadata` / `write` / `storage` / `ai` / `net` / `assets` / `ui`): `src/renderer/plugins/pluginApi.ts::createPluginApi`
- Read-only metadata domain definitions: `src/renderer/plugins/metadata/domains.ts`; write action definitions and authorization checks: `src/renderer/plugins/writes/index.ts::executeWrite`
- iframe panel bridge: `src/renderer/plugins/pluginIframeBridge.js`; panel host: `src/renderer/components/rightPanel/PluginPanelContent.tsx`
- Script plugin host (isolated-world injection, `GM_*` and `snow` shims, anchors and slots, cleanup): `src/preload/clientScriptHost.ts::initClientScriptHost`
- Script plugin matching and push: `src/main/app/userscriptSyncStore.ts::matchesClientContext`, `::applyClientScripts`
- Script metadata parsing (`@snow-target` / `@snow-view` / `@snow-surface` / `@snow-scope` / `@snow-sandbox` / `@snow-privacy`): `native/src/storage/userscripts.rs::parse_meta`
- Management UI: `src/renderer/components/sidebar/PluginsPanel.tsx`, `src/renderer/components/sidebar/PluginScriptsSection.tsx`
