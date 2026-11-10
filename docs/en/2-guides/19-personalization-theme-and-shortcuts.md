# 19-Personalization, Theme, and Shortcuts

> This guide explains Snow App's rule composition, request configuration, theme, language, and keyboard-shortcut behavior. The Settings sidebar currently contains 25 settings pages; this guide covers System Prompt (settings page id: `system-prompt-settings`), Personalization (`personalization-settings`), Custom Headers (`custom-headers-settings`), Theme Settings (`theme-settings`), and Keyboard Shortcuts (`keyboard-shortcuts-settings`). The language selector is a separate area below the settings list, not a twenty-sixth page.

## Configuration Flow and Effective Boundaries

```mermaid
flowchart LR
    G[Global ROLE] --> P[Prompt composition]
    R[Project ROLE] --> P
    C[Current conversation instructions] --> P
    S[SQLite system_prompts] --> A[API profile]
    H[SQLite custom_header_schemes] --> A
    A --> Q[Request assembly]
    P --> Q
    T[SQLite system_settings] --> UI[Theme language shortcuts]
    F[Background and cursor files] --> UI
```

The renderer accesses the main process or Rust storage layer through preload APIs and IPC. File-based rules live under `~/.snow/` or the workspace, while structured settings are primarily stored in `~/.snowapp/snowapp.db`. Changing a rule does not rewrite historical messages; it mainly affects subsequent prompt construction and the next conversation request.

## Personalization Rules

### Global ROLE

The global rules file is `~/.snow/ROLE.md`. The Personalization page reads and saves it through preload → IPC:

- if the file does not exist, the editor shows an empty draft;
- saving creates the `~/.snow/` directory when necessary;
- global rules apply to projects that allow global rules to be loaded;
- rule content can change model behavior and should be reviewed like code or configuration before saving.

### Project ROLE

Project rules live at `<workspace>/ROLE.md` and the editor only modifies the active project. Local and SSH workspaces are supported; the main process uses the remote-access path to read and write SSH workspace rules.

Whether a project loads global rules is controlled by `role.includeGlobalRules` in `<workspace>/.snow/settings.json`. The default is `true` when the field is absent.

### Override Built-in Prompt

The global and project rule editors (and the ROLE.md dialog opened from the chat input) provide an "Override built-in prompt" switch. It maps to whether `role.overrideRoleIds` in the scope's `settings.json` contains `active` (compatible with Snow CLI):

- off (default): the rules replace the role line at the top of the built-in prompt; the remaining built-in sections are kept;
- on: applies to normal mode only — the rules replace the whole built-in template, while platform commands, working directory, date and tool-related dynamic sections are still appended; Goal / WorkFlow / WorkTree modes carry explicit workflow guidance and are never replaced, the rules are embedded the same way as when the switch is off;
- the switch does not affect system prompts bound in the API profile: when they are configured they still occupy the system prompt slot and the built-in prompt (the rules, when enabled) is demoted to the first user message;
- when global and project rules are both loaded, enabling the switch in either scope takes effect; if a project turns off "Load global rules", the global switch does not apply to that project.

### Load Order and Precedence

The composition order shown by the UI is:

1. global rules;
2. project rules;
3. current conversation instructions.

All enabled scopes are loaded. Later instructions take precedence only when instructions conflict; non-conflicting rules remain active together. After switching projects, verify that the editor is showing the intended workspace before saving.

## System Prompts and API Profiles

System-prompt templates are stored in the SQLite `system_prompts` table. They can be created, edited, enabled, disabled, and deleted, and Snow CLI configuration can be synchronized from `~/.snow/system-prompt.json`. Templates have either `global` or `project` scope.

An API profile's `systemPromptIdsJson` has three states:

| Value             | Behavior                                                       |
| ----------------- | -------------------------------------------------------------- |
| Empty string      | Inherit globally enabled system prompts                        |
| `__DISABLED__`    | Use no user-configured system-prompt template for this profile |
| JSON string array | Bind an explicit list of system-prompt IDs                     |

At runtime, effective user prompts map to each provider's protocol: a `system` message for Chat Completions, `instructions` for Responses, top-level `system` for Anthropic, and `systemInstruction` for Gemini. Whenever user prompts are present, they exclusively occupy that provider system field. Snow's built-in Agent prompt is not discarded; it is demoted to a leading `user` message. Without a user prompt, the built-in prompt remains in the provider system field. Consequently, `__DISABLED__` disables user templates rather than removing Snow's built-in Agent instructions.

Before disabling or deleting a template, check the profiles that use it. An explicit ID list is not equivalent to inheriting global prompts.

## Custom Request Headers

Header schemes are stored in the SQLite `custom_header_schemes` table. They can be created, edited, enabled, disabled, and deleted. Header names must be unique within a scheme, and Snow CLI configuration can be synchronized from `~/.snow/custom-headers.json`.

> **Know the two entry points**: `~/.snow/custom-headers.json` is only a Snow CLI
> compatibility sync source — writing it does not change the headers the app sends
> (the user must click "Sync Snow CLI custom headers" in the panel). The app's live
> configuration is the database table above. To let an agent maintain live headers
> directly, use
> `config-manage action=set scope=customHeaderSchemes key=<schemeId> value={name?, headers?, isActive?}`:
> `headers` is merged (set a header to `null` to remove it) and `isActive:true`
> activates the scheme exclusively; changes apply to subsequent API requests
> immediately (in-flight requests are unaffected).

Below the header list, the scheme editor shows an "Available variables" hint listing the six equivalent session-ID spellings (`{{session_id}}`, `{{sessionId}}`, `{{conversation_id}}`, `{{conversationId}}`, `${session_id}`, `${conversation_id}`): clicking one inserts it at the caret position inside the header value, where it can be combined with other text.

An API profile's `customHeaderSchemeId` also has three states:

| Value          | Behavior                         |
| -------------- | -------------------------------- |
| Empty string   | Inherit the global header scheme |
| `__DISABLED__` | Add no custom headers            |
| Scheme ID      | Bind the specified header scheme |

Custom headers are injected after Snow sets authentication and protocol headers. Empty names/values are skipped, while an invalid HTTP header name or value fails the request. Reserved names are matched case-insensitively and cannot override application-managed values:

| Provider protocol              | Headers a custom scheme cannot override                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Chat Completions and Responses | `Authorization`, `Content-Type`, `Accept-Encoding`                                                     |
| Anthropic                      | The preceding three plus `X-API-Key`                                                                   |
| Gemini                         | `Content-Type`, `Accept-Encoding`; the API key is in the URL query rather than an Authorization header |

### Session Variable in Header Values

Header values support the `{{session_id}}` template placeholder: when a request is sent, it is replaced with the session ID of the conversation that issues it (the conversation's `conversation_id`, shaped like `conv-<timestamp>-<pid>`), and it can be combined with fixed text (for example `snow-app-{{session_id}}`). The aliases `{{sessionId}}`, `{{conversation_id}}`, and `${session_id}` are equivalent.

- Conversation-scoped requests expand to the current session ID: Chat Completions, Responses, Anthropic, Gemini, Interactions, and conversation summaries; a sub-agent conversation uses its own session ID.
- Requests without a session context (model listing, codebase review, standalone image reading, and similar helpers) omit the header instead of sending the literal `{{session_id}}`.
- Unrecognized placeholders are left untouched and everything else is sent as-is.

> **Security warning:** Headers may contain API keys, bearer tokens, cookies, or other secrets. Do not share raw configuration files, the database, request logs, or screenshots that expose headers. Redact troubleshooting material first.

## Theme Settings

### Modes, Presets, and Custom Colors

Theme mode supports `system`, `light`, and `dark`. You can select a built-in preset or maintain separate light and dark palettes. Changes are previewed immediately and automatically saved with a 1,000 ms debounce; restoring defaults and applying AI-generated colors persist immediately.

The theme is stored as the `theme_settings` record in SQLite `system_settings`, including:

- `mode` and `presetId`;
- `custom.light` and `custom.dark` palettes;
- `background` (source, image list, carousel settings, opacity, and blur);
- `fontFamily`;
- `typography` (UI font size, body font weight, chat font size / line height, code font size);
- `streamCursor`.

The renderer also keeps a fast localStorage theme cache to reduce startup flashing. SQLite remains the persistent settings source.

### Background, Font, and Streaming Cursor

The background has two mutually exclusive sources:

- **Image**: background images are managed as a list of up to 30 entries. “Add images” accepts several local files in a single selection (`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`); Snow App copies each file to `~/.snowapp/backgrounds/` and no longer continuously references the original file. The list is displayed as a thumbnail grid where entries can be removed one by one; clicking a thumbnail pins that image as the background and ends the automatic carousel; images beyond the 30-image limit are reported as not added.
- **Pet**: when you select an installed desktop pet, that pet's idle animation loops on the top layer as an animated background, with a 20%–150% size control (relative to the window height); the playback speed follows the speed multiplier in Settings > Desktop pet.

The renderer reads image resources through the restricted `theme-bg://` protocol.

Both sources share the enabled state, opacity, and a blur value from 0 to 100; opacity is capped at 60% and, together with blur, applies to the whole background layer. The `source` field in `background` marks the active source, and `petId` / `petScale` only apply to the pet source.

#### Automatic Carousel

An image list can rotate automatically, and the carousel can be toggled at any time:

- **Interval**: 10 seconds to 2 hours, choosing among 10 seconds, 30 seconds, 1 minute, 5 minutes, 15 minutes, 30 minutes, 1 hour, and 2 hours; the default is 5 minutes;
- **Order**: “Sequential” or “Random”; the default is sequential;
- **Transition**: a cross-fade of about 0.6 seconds, with the next image preloaded before the switch so that no blank frame appears;
- **Scope**: the carousel runs only while the app is running;
- **Playback position**: in sequential mode, the next launch or the next time the carousel is enabled continues from the image that was displayed last; in random mode, each playback starts from a randomly chosen image; when the carousel is turned off or an image is pinned by clicking its thumbnail, the image on screen is remembered and is still shown after a restart;
- **Single image and off state**: with one image in the list or the carousel disabled, the background stays static and never switches.

#### Image History and File Retention

Every background image you have added stays in the application-managed `~/.snowapp/backgrounds/` directory. The “Image history” dialog lists those files and can add an image back to the list. Whether the file is deleted from disk depends on where you delete it:

| Action                                | List    | File in `~/.snowapp/backgrounds/`                  |
| ------------------------------------- | ------- | -------------------------------------------------- |
| Remove an image from the current list | Removed | Kept; re-add it from image history later           |
| Reset the theme                       | Cleared | Kept; re-add it from image history later           |
| Delete an image in “Image history”    | Removed | Deleted from disk as well; it cannot be added back |

The font can use the system default or a selected family. The same area also provides typography settings: UI font size (12–18 px, where 13 px = 100%, applied as whole-app zoom equivalent to Electron `webFrame.setZoomFactor`), body font weight (100–900, free input), chat font size (12–20 px), chat line height (1.2–2.4), and code font size (10–18 px, applied to chat code blocks and inline code); the UI font size can also be adjusted with keyboard shortcuts and persists immediately. The streaming cursor supports:

- the default pulsing `dot`;
- a built-in `lucide` icon;
- a `custom` SVG.

Custom SVGs are copied to `~/.snowapp/stream-cursors/`. Cursor size is normalized to 8–48, with a default of 14. Invalid icon types or missing required paths fall back to the dot.

### AI Color Generation

AI color generation uses the first image in the background list as visual input. You must select an API profile whose advanced model supports vision. Applying the result writes the theme immediately. Because the background is sent to the selected model, review the provider's data-handling policy before using private images.

## Language

Snow App supports `en`, `zh-CN`, and `zh-TW`. The language selector is a separate area at the bottom of the Settings sidebar.

- Fast cache: renderer localStorage key `snow.locale`;
- persistent source: the `language` record in SQLite `system_settings`;
- without a localStorage cache, the app first reads the database;
- without a valid database value, it matches the browser language and falls back to English when no match exists.

`~/.snow/language.json` belongs to the Snow CLI configuration domain and is not the single source of truth for the current UI language.

## Desktop Pet

The "Desktop pet" page in the settings sidebar manages your desktop pet:
install pet packages (`.zip`) from Codex App, Petdex, or Snow App, pick the
active pet, and toggle between waking (showing on your desktop) and dismissing
(hiding) it. While awake, a slider adjusts the display size (0.5–2x, default
0.75). The pet reacts to your AI work in real time.

Snow App ships an official built-in pet (`resources/pets/*.zip`) that is
installed automatically into `~/.snowapp/pets/` on first launch — no manual
install needed. If you already installed a pet with the same id, that directory
is overwritten and the list is de-duplicated by id, so no duplicate entries
appear. The built-in pet cannot be uninstalled (its list entry has no delete
button), a user package with the same id cannot replace it, and the data cleanup
keeps it. After an upgrade, the built-in pet is refreshed when the app version or
the package content changes; if its directory goes missing, it is reinstalled on
the next launch (marker file `~/.snowapp/builtin-pets.json`). Extraction runs in
the Rust backend and never blocks the main process.

## Keyboard Shortcuts

### Default Bindings

`Mod` means the platform's primary modifier: Command on macOS and Control on other platforms.

| Action                     | Default key                             |
| -------------------------- | --------------------------------------- |
| Cancel the current session | `Escape`                                |
| Open search                | `Mod+F`                                 |
| Open memo                  | `Mod+B`                                 |
| Open TODO                  | `Mod+T`                                 |
| Cycle project              | `Mod+Backtick`                          |
| Open project explorer      | `Mod+D`                                 |
| Cycle API profile          | macOS `Ctrl+P`; other platforms `Alt+P` |
| Increase UI font size      | `Mod+=`                                 |
| Decrease UI font size      | `Mod+-`                                 |
| Reset UI font size         | `Mod+0`                                 |

These shortcuts are enabled by default with `foregroundOnly=true`. Their JSON configuration is stored in the `keyboard_shortcuts` record in SQLite `system_settings`.

### Rebinding, Conflicts, and Scope

Each shortcut can be enabled independently, rebound, and reset. The page can also restore all default keys. While recording a normal action, `Esc` cancels recording; while recording “Cancel the current session,” `Esc` is a valid binding. Recording supports the **Shift modifier key** (for example `Cmd/Ctrl+Shift+P`), which is recognized and saved through event conversion, display, and matching logic.

The page reports binding conflicts but does not choose a resolution for you. At runtime, only the first matching action in action order is triggered. A local component may intercept an action—for example, a focused file viewer can use the search shortcut for in-file search.

The “Foreground only” value is persisted, but the current engine is based on renderer `document.keydown` events. Consequently, even when this option is off, shortcuts only work while the app is focused and able to receive keyboard events. They are not operating-system global shortcuts.

## Storage, Lifecycle, and Security Boundaries

| Data                              | Location                                                 | Lifecycle                                                                                       | Security boundary                                                        |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Global ROLE                       | `~/.snow/ROLE.md`                                        | Retained until the user overwrites or deletes it                                                | Can affect every project that loads global rules                         |
| Project ROLE and switch           | `<workspace>/ROLE.md`, `<workspace>/.snow/settings.json` | Retained with workspace files                                                                   | Limited to the current project; SSH content uses the remote-access path  |
| System prompts and header schemes | `~/.snowapp/snowapp.db`                                  | Retained until UI deletion, database migration, or recovery                                     | May contain instructions and secrets; database backups are sensitive too |
| Theme, language, and shortcuts    | SQLite `system_settings`                                 | Retained until changed, reset, or the database is replaced                                      | localStorage is only a startup cache, not a replacement source of truth  |
| Backgrounds and cursor SVGs       | `~/.snowapp/backgrounds/`, `~/.snowapp/stream-cursors/`  | Managed copies survive list removals and theme resets; only image-history deletion removes them | `theme-bg://` exposes only controlled local resources                    |

For the full directory, backup, and restore boundaries, see [Data Storage Locations](../3-reference/4-data-storage-locations.md).

## Troubleshooting

### Why do old messages remain unchanged after I edit ROLE?

ROLE is read during subsequent prompt construction. It does not rewrite stored message history. Validate the change with the next request.

### Why does a shortcut not fire in another app after I turn off “Foreground only”?

The current engine uses renderer keyboard events, which stop when Snow App loses focus. The option does not currently register an operating-system global shortcut.

### Does deleting the original background image break the theme?

No. Adding an image copies the file to `~/.snowapp/backgrounds/` and registers the copy as image history; removing it from the list or resetting the theme never deletes the copy, so you can add it back at any time. Only deleting the image in the “Image history” dialog removes the copy from disk, after which it cannot be added back.

### Why is an API profile not using the global prompt or headers?

Check whether the profile is set to `__DISABLED__` or has an explicit ID binding. Only an empty string means inherit the global configuration.
