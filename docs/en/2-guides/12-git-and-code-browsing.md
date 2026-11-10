# 12-Git Panel & Code Browsing

This guide covers four code-related areas: the **Git panel** (repositories, branches, changes, commits, and synchronization), the **project explorer** (local/SSH trees and workspace search), the **right-panel file reader** (multi-tab viewing, editing, and in-file search), and the **codebase panel** (semantic search and the 3D relationship sphere).

## 1. Git Panel

### 1.1 Opening and Repository Selection

- Open the **Git tab** in the right panel. Repositories under the workspace are discovered automatically;
- Use the **repository selector** to switch the active repository. Its context menu can copy the repository path, reveal it in the file manager, or open a terminal there;
- Local and `ssh://` remote repositories use the same panel operations. See [Terminal and SSH](11-terminal-and-ssh.md) for SSH connection behavior.

### 1.2 Branches

The branch selector groups **local branches** and **remote branches** separately. Selecting another entry checks it out and refreshes status. **Create branch** validates the name, rejects duplicates, then creates and switches to the new branch. The branch button's context menu can also copy the current branch name, start branch creation, or refresh the list.

### 1.3 Changes, Staging, and Diffs

| Operation          | Behavior                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspect changes    | The **Changes** view separates unstaged and staged files and shows added/modified/deleted status; click a file to open its corresponding diff |
| Select one or many | A normal click selects one item; `Ctrl/Cmd` adds/removes items and `Shift` selects a range within the same section                            |
| Stage/unstage      | Act on selected items, or use the section action to stage all or unstage all                                                                  |
| Discard changes    | Request discard for one or more unstaged files; a confirmation dialog is required before the operation runs, then status refreshes            |
| File shortcuts     | Open a file in the file reader or open a terminal at its location; local paths can also be revealed in the file manager                       |

Use the toolbar to switch between **Changes** and **Graph**. Graph pages through commit history and renders commit relationships and branch/remote/tag decorations. Expanding a commit reveals **its file list and per-commit diff**:

- **View per-commit diff**: after expanding a commit, click a file entry to show that file's diff **within this commit** in the right panel (View File Diff in This Commit); the file being viewed is highlighted in the list;
- **Open in new tab**: the file entry's context menu supports **Open Diff in New Tab** (the tab opens in a loading state first, then fills in asynchronously) and **Copy File Path**;
- **Remote repository support**: per-commit diff viewing works for both local repositories and `ssh://` remote repositories (remote repos run through the SSH channel).

A manual refresh reloads both status and the graph when Graph is active.

### 1.4 Commits, AI Commit Messages, and Remote Sync

- **Commit prerequisites**: at least one file must be staged and the commit message must be non-empty; otherwise the commit button is disabled;
- **AI commit message**: staged files are also required. The sparkle button reads the **staged diff** and uses the current active API profile's `basicModel` to stream a proposed message directly into the input. While generation runs, the button becomes a stop control. Stopping or cancelling the stream preserves text already received so you can edit it manually;
- **Synchronization**: the toolbar provides pull, push, and manual status refresh. When the panel opens it also runs a background fetch immediately and repeats it every 60 seconds while the window is visible. Successful fetches refresh ahead/behind counts for both local and SSH repositories; unattended errors such as offline, authentication, or no remote are ignored;
- **Commit mode**: a drop-down next to the commit button switches between **Commit only** and **Commit and push**. The choice is persisted and restored after restart. In commit-and-push mode, push runs automatically after a successful commit and push failures are surfaced as errors while the commit stays intact;
- **Feedback**: ahead/behind counts appear at the top and a behind badge decorates pull. Pull/push failures are shown to the user, while background fetch never interrupts the panel.

```mermaid
flowchart TD
    A[Stage files<br/>at least one staged file] --> B{Commit message}
    B -- AI generated --> C[Click the star button<br/>reads the staged diff, basicModel streams it]
    C --> D[Generated text lands in the input<br/>still editable by hand]
    B -- manual --> D
    D --> E[Commit<br/>non-empty message]
    E --> F[pull / push sync<br/>panel background-fetches every 60s]
    F --> G[Feedback<br/>ahead/behind badges, failures shown]
```

> **AI collaboration**: after the AI changes files, use `/file-changes` in chat or the Git panel to inspect and stage them. Asking the AI to execute Git commands in a terminal is separate from using these panel controls and remains subject to tool authorization and sensitive-command policy.

### 1.5 Git Worktree Management & Isolated Commit Flow

Git WorkTree allows a single repository to mount multiple physical directories checked out at different branches simultaneously. This eliminates the need for frequent `git stash` and checkout steps, completely isolating feature experiments and concurrent task development.

#### 1. Worktree Awareness & Branch Selector Integration

- **Active Worktrees Pinning**: opening the branch selector in the Git panel or global TopBar displays an **Active Worktrees** group at the top, showing the checked-out branch, folder name, and dirty status (`Clean` / `Dirty`);
- **Quick Actions**:
  - **Copy Path**: copy the absolute filesystem path of the worktree;
  - **Open Terminal**: launch an interactive terminal pinned to the worktree path as its `cwd`;
  - **Safe Deletion**: remove temporary worktrees (main worktree is protected; dirty worktrees require confirmation; worktrees bound to active sessions cannot be deleted);
- **Create Worktree**: choose **New Worktree** from the branch menu, supply the new branch name and destination path, and Snow automatically executes `git worktree add` and tracks it.

#### 2. Welcome Screen Worktree Cards & Session Binding

- **Welcome Grid**: on an empty chat screen ("What do you want to work on in xxx?"), Snow scans and displays all current worktrees as interactive cards;
- **One-Click Session Binding**: clicking any worktree card (e.g. `ui` directory on branch `feature/ui-performance`) immediately creates a dedicated conversation bound to that worktree;
- **Visual Badge**: the bottom-left chat toolbar displays a green branch badge reflecting the bound worktree, ensuring all tool operations and prompts operate strictly inside that directory.
- **Chat List Marker**: conversations bound to a non-main worktree show a branch icon and branch name in the sidebar list; hovering reveals the full worktree path. The main worktree equals the project root and shows no marker.
- **Git Panel and TopBar Follow the Session**: opening such a conversation switches the right-hand Git panel and the TopBar branch selector to that worktree's repository — the changes list, commit graph, commit and push all target the worktree. Missing or invalid bindings (e.g. the worktree was deleted externally) fall back to the project directory.
- **Switch Boundaries**: changing a branch inside the worktree panel only changes that worktree's checkout and never rewrites the session binding; only selecting another worktree rewrites it.

#### 3. Development, Diff, and Commits in a Worktree

- **Physical Root Isolation**: file tools and terminal execution take `executionWorkspaceRoot` as their working directory;
- **Accurate Diff & Checkpoints**: `/file-changes` and checkpoint snapshots only track modifications within this worktree, preventing bleed across branches;
- **AI Commit & Push**: stage modified files in the Git panel, click the sparkle button to generate a clean, standard commit message, and choose **Commit only** or **Commit and push**.

### 1.6 Git Repository Settings

**Settings → Git Repository Settings** (settings page id: `git-settings`) configures repository status scanning and refresh behavior:

- **Scan depth**: directory depth for status scanning (default `1`, mirroring VSCode);
- **Ignored folders**: directories skipped by the change watcher;
- **Change-watcher debounce**: how long file changes are coalesced before refreshing status;
- **SSH poll interval**: status polling period for SSH repositories;
- **Status change limit**: local Git status is truncated at the configured limit with a warning shown in the Git panel, keeping huge repositories responsive;
- **Auto refresh**: whether repository status refreshes automatically.

### 1.7 Commit Author Avatars

The commit hover card shows the commit author's avatar in its top-left corner. Each level is tried in order, falling back to the next only when the previous one fails:

1. **GitHub lookup**: queries `api.github.com` for that commit and uses the avatar of the account GitHub associates with the commit email. This level covers authors the static rules cannot resolve (Gmail addresses, for example), but requires the commit to have been pushed to a remote; non-GitHub remotes skip this level.
2. **Static derivation**: builds a URL directly from the email, with no API request:
   - `…@users.noreply.github.com` → `github.com/<login>.png`;
   - `…@qq.com` → the QQ number avatar from `q1.qlogo.cn`;
   - anything else → the real Gravatar avatar (`md5(email)`).
3. **Gravatar geometric pattern**: when the email has no Gravatar account, a geometric pattern (identicon) derived from the email hash is used instead. The pattern is stable per author and differs between authors.
4. **Initial-letter tile**: when none of the above is usable, it falls back to a colored tile with the author name's first letter.

**Authentication and rate limits for the GitHub lookup**: GitHub allows 5000 requests/hour when authenticated but only 60/hour anonymously. Snow reads the `GITHUB_TOKEN` then `GH_TOKEN` environment variables (the latter is written by the gh CLI after `gh auth login`), matching the convention already used by the built-in Skills installer. Without a token it still attempts an anonymous request, which may hit the limit sooner; the avatar then simply falls back to level 2 or lower, with no impact on other features. Lookup results are cached per repository for 7 days (in `git-author-avatars.json` under the app data directory), so normal browsing does not repeat requests.

> Avatars are decorative: network failures, rate limiting, or non-GitHub repositories only make the avatar fall back to the next level — they never raise an error or block the UI.

## 2. Project Explorer and Workspace Search

Choose **Details** from a workspace's ellipsis/context menu to open that workspace in the project explorer:

- **Local and SSH trees**: both expand directories on demand, refresh, open text files in the right-panel reader, and rename or delete files/directories from the context menu. SSH operations run through the current remote session;
- **Multi-select in the file tree**: the local file tree supports `Ctrl/Cmd`-click toggling, `Shift` range selection, and `Ctrl+A` select-all for batch operations across multiple entries;
- **File/directory context menu**: local entries additionally support **Open in Terminal** (for a file, its containing directory), **Open with System Default App** (files only; opens the file with the OS-associated app, such as Word, PowerPoint, or a PDF viewer), **Reveal in system file manager**, **Copy Path**, and an **Open with** submenu (open the directory with an installed IDE; detection matches the workspace-directory menu). SSH remote entries do not offer the file manager, system default app, or IDE open actions;
- **Deletion boundary**: deleting in the explorer changes the real local or remote filesystem. It is different from removing a workspace registration from the project list, so verify the target first;
- **Local workspace search**: local workspaces show **Search files and content**, matching both file names and text contents. Click a result's file name to open the whole file, or click a matching line to open and briefly highlight that line. `Ctrl/Cmd` and `Shift` can select matching lines before dragging them into chat;
- **SSH search difference**: an SSH workspace still supports browsing, rename, delete, and file opening, but does not show this same **Search files and content** bar.

## 3. Right-Panel File Reader, Editing, and In-File Search

The right panel is a **multi-tab** file reader. It reads local files or remote files through an existing SSH session, and editable text can be changed and saved back to the corresponding local or remote path.

| File type        | Support                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text/code        | Includes `.sql` and CSV: syntax highlighting, line numbers, target-line navigation, and in-file search; editing/saving is available when the original bytes can round-trip losslessly |
| Markdown (`.md`) | Rendered preview for headings/tables/code/math/diagrams plus source mode; relative file links open in another tab; editing switches to source                                         |
| Images           | Preview; SVG has image/code dual modes                                                                                                                                                |
| Local Office/PDF | `.docx`, `.doc`, `.xlsx`, `.xls`, `.xlsb`, `.xlsm`, `.ods`, `.pptx`, `.ppt`, `.pdf`: extracted text, read-only, searchable and copyable                                               |
| Binary           | A **Binary file** placeholder, with no text editing                                                                                                                                   |

### Local Document and SQL Preview Boundaries

- Use **Open file** on a Git **Changes** entry to read the current working-directory file. This is not an Office diff of the index or a historical commit and does not change existing diff semantics.
- Office/PDF previews show **Read-only preview**. They do not preserve Word layout, Excel styles/charts or PPT animations, recalculate Excel formulas, or provide OCR for scanned PDFs. Native OOXML text extraction does not run document macros; security behavior of system converters used for legacy formats depends on their local configuration.
- Document input is limited to **20 MiB** and extracted text to **2 MiB**. Exceeding either limit produces an explicit error, not silent truncation. The text limit is checked after the existing extractor returns the full text; it is not a peak-memory bound during parsing.
- Legacy `.doc/.ppt` uses the existing system-tool path (macOS textutil, installed LibreOffice) and UTF-16 text-scan fallback. Extraction may be incomplete; failures advise conversion to a modern format.
- `.sql` and CSV remain ordinary text, not extracted Office documents. Reading reuses encoding detection. Saving first verifies that re-encoding the original text with its detected encoding/BOM reproduces the original bytes exactly, then saves with that encoding. Text that cannot round-trip (currently including UTF-16) is read-only; UTF-32 retains the binary placeholder.
- This extension is **local only**. SSH files continue using the existing remote reader; remote Office extraction is not promised.

### Open-Source Reuse and PR Disclosure

This feature adds no dependency, upgrades no parser, and ports no external project source code. It connects the repository's existing file-tool parsers to the reader. PRs must distinguish **existing dependency reuse**, **new dependencies**, and **inspiration/code ports**; a researched but unadopted project must not be listed as used.

| Existing project                                                                                            | Actual reuse in this feature                                                                  | License declaration                  |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| [calamine](https://github.com/tafia/calamine "Pure Rust Excel and OpenDocument spreadsheet reader")         | Read Excel/ODS cells sheet by sheet through the existing text extractor                       | MIT                                  |
| [pdf-extract](https://github.com/jrmuizel/pdf-extract "Rust library for extracting PDF text")               | Extract PDF text, without page rendering or OCR                                               | MIT                                  |
| [zip](https://github.com/zip-rs/zip2 "Rust ZIP archive reader and writer")                                  | Existing DOCX/PPTX OOXML container access; XML-tag-to-text conversion remains repository code | MIT                                  |
| [chardetng](https://github.com/hsivonen/chardetng "Legacy text character-encoding detector")                | Detect ordinary text encodings                                                                | Apache-2.0 OR MIT                    |
| [encoding_rs](https://github.com/hsivonen/encoding_rs "Rust implementation of the Encoding Standard")       | Decode text and write back the original encoding when lossless                                | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| [highlight.js](https://github.com/highlightjs/highlight.js "Multilanguage code highlighting including SQL") | Retain the file reader's existing SQL/code syntax highlighting                                | BSD-3-Clause                         |

Resolved versions come from `native/Cargo.lock` and the frontend lockfiles. Distribution must retain upstream license and copyright notices. PRs should also state local/SSH, read-only/editable, and extracted-text/original-layout boundaries, actual validation results and coverage gaps.

### Snow-Side Review Annotations

- Open a real file and select **Review annotations** in the reader toolbar. Markdown switches to source view. Selection annotations are unavailable in edit mode, images, and virtual script content.
- Select text and choose **Annotate selected text** from its context menu, or use the toolbar add button. One selection is limited to **4096 UTF-16 code units**, and annotation content to **8 KiB UTF-8**. Selections across folded or virtualized-away rows are rejected rather than quoting unseen text.
- Save, edit, copy, locate/highlight, or fill the chat draft with one or all annotations. Filling a draft does not send a message. Deletion requires a second click to confirm.
- Annotations live in Snow's separate `file_review_annotations` table. They never modify the source file, write native DOCX/XLSX comments, or share Git diff old/new-side comment records.
- Local scope uses normalized absolute file paths, keeping different worktrees separate. SSH scope uses a registered stable workspace ID and remote absolute path; no stable ID means no annotation entry. Late async results from an old file do not populate the new file's annotation list.
- Anchors store selected text, surrounding context, and a SHA-256 of the displayed text. Unchanged content uses its original position. Changed content relocates only when the entire context matches uniquely, with an explicit status. Missing or ambiguous matches retain the annotation and disable navigation; no fuzzy guessing is performed.
- For Office files already available as extracted text, annotations target that text view only: line numbers are not Word pages or Excel cells. This feature adds no Office parser. Structural anchors provided by future marketplace editing plugins are outside this release.
- Builds containing the new native API require a full Snow process restart, not just a renderer reload. Normal application initialization runs an idempotent migration from schema **53 to 54**, adding the independent table and indexes without migrating or deleting existing Diff comments.
- Even for SSH source files, annotations stay in the local Snow database and never write the remote file. Renaming, moving, or deleting a source file does not automatically transfer its annotations to another path.
- Opening the panel never sends selected text to a model. Filling the chat input only creates a draft; it enters the ordinary chat request flow only when the user later sends it explicitly.

Implementation anchors: `src/renderer/components/rightPanel/FileReviewPanel.tsx`, `src/renderer/components/rightPanel/fileViewer/fileReviewAnchors.ts`, `src/main/ipc/handlers/fileReviewAnnotationHandlers.ts`, `native/src/storage/services/file_review_annotations.rs`, and `native/src/storage/migrations.rs::migrate_file_review_annotations`.

Editing and search shortcuts:

- Enter edit mode with the edit button. `Ctrl/Cmd+S` saves and `Esc` exits; exiting with unsaved changes requires confirmation;
- When a file reader has focus, `Ctrl/Cmd+F` opens **in-file search** instead of global search. A Markdown preview switches to source mode automatically;
- Search has a match-case toggle. `Enter` goes to the next match, `Shift+Enter` to the previous match, and `Esc` closes search. Both view and edit modes navigate to the current match.

The file reader shares language aliases, file-path language resolution, and light/dark syntax colors with chat code blocks, HTML source, and tool code views. Highlight caches are isolated by normalized language, chunk content, and context to prevent color leakage when the same text is opened as different languages; existing chunking and virtual scrolling remain unchanged.

Large files:

- Files with tens of thousands of lines render on demand (virtual scrolling): only the visible region is highlighted and measured, while folding, jumping to a line, and in-file search keep working;
- Above the large-file threshold, edit mode keeps a native input for typing while the line-number gutter and the syntax-highlight layer render only the visible window, so typing and scrolling stay responsive.

### Markdown Preview Tips

- **Wide tables** scroll horizontally instead of being clipped;
- **Math** uses `$...$` inline and `$$...$$` block syntax (KaTeX);
- **Diagrams** use a `mermaid` fenced code block and render interactively, with code/diagram switching and download;
- **View switching** uses the **Render preview / Source** toolbar controls; editing automatically selects source.

## 4. Global Search

Global search combines three kinds of objects:

1. **Conversations**, matched by title, summary, and searchable message content;
2. **Projects/workspaces**, matched by display name or path and activated when selected;
3. **All 25 settings pages**, matched by localized page name or settings-page id and opened directly when selected.

Results are grouped as conversations, projects, and settings. Use `Up` / `Down` to cycle through items and `Enter` to open the current result. Hovering or clicking with the mouse also updates/selects the current item.

## 5. Codebase Panel and Semantic Search

### 5.1 Enabling

Enable codebase indexing in **Settings → Codebase**
(`app-control-openSettings page=codebase-settings`) and configure an embedding
model; the first index may take a few minutes. Once enabled:

- `/codebase` in the chat input opens the project codebase panel;
- the AI gains the `codebase-search` tool (see
  [7-codebase-index-and-diagnostics](7-codebase-index-and-diagnostics.md));
- when **Agent Review** is enabled in codebase settings, its review loop uses the
  current active API profile's `basicModel`. Vector indexing continues to use the
  separately configured embedding model and does not participate in basic/advanced
  routing.

### 5.2 3D Similarity Sphere

The codebase panel includes a **3D sphere view**: each file is a node whose
distance reflects embedding similarity. Drag to rotate, zoom to inspect file
clusters and relationships (layout is computed on a Rust background thread,
so the UI stays responsive).

### 5.3 Natural-Language File Search

Type `@?<query>` in the chat input to start a **natural-language file
search**: the AI combines grep/filesystem tools to locate relevant files,
showing progress and results in real time. This file-search Agent uses the current
active API profile's `basicModel`; it does not switch to `advancedModel` based on
query complexity.

### 5.4 Codebase Panel (next to the input)

- **Scan preview**: shows file count/size before indexing to avoid indexing
  huge directories by accident;
- **Index stats**: file count, embedding progress; start/rebuild index as
  needed;
- **Embedding progress**: live progress; semantic search works as soon as it
  completes.

## 6. Open a Workspace in a Local IDE

A local workspace's directory menu can detect installed IDEs and pass the project directory to one of them:

1. In the left workspace list, open the ellipsis or context menu for a **local workspace**;
2. Expand **Open with**. Snow scans installed IDEs when this submenu is first needed;
3. Select an IDE. The menu item's title exposes the detected executable path;
4. If no candidate is found or launch fails, the menu reports the detection/opening error.

The known recognition table includes Visual Studio Code/Insiders, Cursor, Windsurf, Trae, Zed, Sublime Text, IntelliJ IDEA, WebStorm, PyCharm, GoLand, CLion, PhpStorm, RubyMine, Rider, DataGrip, Android Studio, Xcode, and Fleet. The actual list depends on the operating system, installation location, and whether Snow can find the executable. This entry is available only for non-SSH workspaces with a local directory path. Use a remote terminal or remote-development tooling for SSH workspaces; this menu cannot launch an SSH URI as a local project directory.

## 7. Troubleshooting

| Symptom                        | Cause & fix                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git panel shows no repos       | Confirm `.git` exists under the workspace; remote repos need an SSH connection first                                                                 |
| No IDE appears under Open with | Confirm the IDE is installed in a detectable system location; close and reopen the directory menu to retry its loading flow in the current session   |
| IDE launch fails               | Check the executable path shown by the menu item, project-directory permissions, and local security policy; SSH workspaces do not support this entry |
| Semantic search unavailable    | Codebase index not enabled or not finished; check the embedding model config                                                                         |
| 3D sphere lags                 | Layout already runs off-thread; for huge repos narrow the index with `fileGlob`                                                                      |
| Preview vs source mismatch     | Markdown preview goes through the renderer; the source view is authoritative                                                                         |

## 8. References

- Codebase configuration: [7-codebase-index-and-diagnostics](7-codebase-index-and-diagnostics.md)
- Storage locations (index, Git state): [3-reference/4-data-storage-locations](../3-reference/4-data-storage-locations.md)
