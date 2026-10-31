import { toolsEn } from "./tools";

/** Mobile remote page · English dictionary. Keep keys in sync with zh-CN.ts. */
export const en: Record<string, string> = {
  // Top bar / connection

  "remote.topbar.connecting": "Connecting to Snow…",
  "remote.topbar.secureLan": "Secure local network",
  "remote.topbar.history": "Chat history",
  "remote.badge.offline": "Offline",
  "remote.badge.running": "Running",
  "remote.badge.aborting": "Stopping",
  "remote.badge.local": "Local",

  // Empty states / offline
  "remote.empty.connecting.title": "Connecting to Snow",
  "remote.empty.connecting.detail": "Reading desktop session",
  "remote.empty.start.title": "Start a new task",
  "remote.empty.start.detail": "Messages are handed to desktop Snow safely",
  "remote.empty.offline.hint": "Check that desktop Snow is still running",
  "remote.empty.unauthorized.title": "Pairing required",
  "remote.empty.failed.title": "Connection failed",
  "remote.error.unauthorized":
    "The access token changed or is no longer valid. Rescan the QR code in Snow.",
  "remote.error.offline": "Cannot reach desktop Snow",
  "remote.error.timeout": "Timed out connecting to desktop Snow",
  "remote.error.badResponse": "Unexpected response format",

  // Token entry
  "remote.unlock.badge": "Token required",
  "remote.unlock.title": "Enter access token",
  "remote.unlock.lead":
    "This phone is not trusted by Snow yet. Enter the token shown in Settings → Mobile remote control on your computer.",
  "remote.unlock.placeholder": "Paste or type the access token",
  "remote.unlock.paste": "Paste",
  "remote.unlock.pasteHint":
    "Cannot read the clipboard — long-press the field and choose Paste",
  "remote.unlock.submit": "Connect",
  "remote.unlock.busy": "Verifying…",
  "remote.unlock.empty": "Enter the token first",
  "remote.unlock.failed": "Invalid token — check it and try again",
  "remote.unlock.tooMany": "Too many attempts — try again later",
  "remote.unlock.success": "Connected",
  "remote.unlock.hint":
    "You can also scan the QR code on your computer — it carries the token automatically. Copy the token from Mobile remote control on the desktop.",
  "remote.unlock.reload": "Reload page",
  "remote.unlock.open": "Enter token",
  "remote.unlock.modeToken": "Pairing token",
  "remote.unlock.modeTotp": "Authenticator",
  "remote.unlock.totpLead":
    "Open Google Authenticator for the 6-digit code and connect without a pairing token.",
  "remote.unlock.totpPlaceholder": "6-digit code",
  "remote.unlock.totpEmpty": "Enter the 6-digit code",
  "remote.unlock.totpFailed":
    "Invalid code, or authenticator unlock is off — check and try again",
  "remote.unlock.totpHint":
    "The code refreshes every 30 seconds; enable it on the computer under Settings → Privacy → App lock.",

  // Timeline
  "remote.timeline.scrollToBottom": "Scroll to bottom",
  "remote.timeline.loadEarlier": "Load earlier messages",
  "remote.timeline.loadingEarlier": "Loading earlier messages…",
  "remote.compaction.generating": "Compacting context…",
  "remote.compaction.summary": "Context summary",
  "remote.compaction.compacted":
    "Context compacted — later AI requests ignore messages before the separator",
  "remote.compaction.copy": "Copy summary",
  "remote.compaction.copied": "Copied",
  "remote.compaction.copyFailed": "Copy failed",

  // Composer
  "remote.composer.placeholder":
    "Ask me anything, type / to open the command panel...",
  "remote.composer.more": "More actions",
  "remote.composer.send": "Send",
  "remote.composer.stop": "Stop",
  "remote.composer.inputLabel": "Message",
  "remote.pending.sendNow": "Send now",
  "remote.pending.withdraw": "Withdraw",
  "remote.pending.sent": "Sent",
  "remote.pending.withdrawn": "Withdrawn — content restored to the input box",

  // Read-only finished bar (sub-agent / workflow node conversation)
  "remote.readonly.backToParent": "Back to main conversation",
  "remote.readonly.subAgent.completed":
    "This sub-agent has finished. The conversation is read-only.",
  "remote.readonly.subAgent.failed":
    "This sub-agent failed. The conversation is read-only.",
  "remote.readonly.subAgent.cancelled":
    "This sub-agent was cancelled. The conversation is read-only.",
  "remote.readonly.workflowNode.completed":
    "This workflow node has finished. The conversation is read-only.",
  "remote.readonly.workflowNode.failed":
    "This workflow node failed. The conversation is read-only.",
  "remote.readonly.workflowNode.cancelled":
    "This workflow node was cancelled. The conversation is read-only.",

  // Conversation TODOs
  "remote.todos.title": "TODO List",
  "remote.todos.progress": "{{completed}} / {{total}} completed",
  "remote.todos.empty": "No TODOs yet — add one below",
  "remote.todos.noConversation":
    "No active conversation — TODOs are stored per conversation",
  "remote.todos.unavailable": "TODO list unavailable — check the desktop",
  "remote.todos.runningHint": "Run in progress — TODOs are managed by the AI",
  "remote.todos.addPlaceholder": "Add a TODO…",
  "remote.todos.add": "Add TODO",
  "remote.todos.delete": "Delete this TODO",
  "remote.todos.confirmDelete": "Delete",
  "remote.todos.cancelDelete": "Cancel",
  "remote.todos.cycleStatus": "Tap to switch to: {{status}}",
  "remote.todos.statusPending": "Pending",
  "remote.todos.statusInProgress": "In progress",
  "remote.todos.statusCompleted": "Completed",

  // Rollback (phone-side confirm sheet backed by the desktop rollback pipeline)
  "remote.rollback.action": "Roll back",
  "remote.rollback.actionHint": "Roll back to this message",
  "remote.rollback.title": "Roll back",
  "remote.rollback.close": "Close",
  "remote.rollback.backToSummary": "Back to rollback summary",
  "remote.rollback.preparing": "Checking file changes…",
  "remote.rollback.preparingHint":
    "Stopping the current run and reading checkpoints — SSH workspaces may take longer",
  "remote.rollback.firstMessageNotice":
    "Rolling back the first message deletes the whole conversation and removes it from the list. File changes from every later round are reverted as well.",
  "remote.rollback.changesNotice":
    "Rolling back reverts file changes from every later round — {{count}} files affected:",
  "remote.rollback.noChangesNotice":
    "No file changes — rollback only deletes this message and everything after it. Continue?",
  "remote.rollback.changeAdded": "Added",
  "remote.rollback.changeModified": "Modified",
  "remote.rollback.changeDeleted": "Deleted",
  "remote.rollback.hiddenChanges": "{{count}} more files not shown…",
  "remote.rollback.viewChanges": "View changes",
  "remote.rollback.previewLoading": "Loading changes…",
  "remote.rollback.previewError": "Failed to load rollback changes",
  "remote.rollback.previewRetry": "Retry",
  "remote.rollback.previewEmpty": "No changes to preview",
  "remote.rollback.previewTruncatedFiles":
    "Showing the first {{count}} files only",
  "remote.rollback.binaryFile": "Binary file — preview unavailable",
  "remote.rollback.tooLargeFile":
    "File exceeds the SSH transfer limit (32 MB) — preview unavailable",
  "remote.rollback.cancelAction": "Cancel",
  "remote.rollback.conversationOnlyAction": "Roll back conversation only",
  "remote.rollback.conversationAndFilesAction":
    "Roll back conversation and files",
  "remote.rollback.confirmAction": "Confirm rollback",
  "remote.rollback.inProgress": "Rolling back…",
  "remote.rollback.todoNotice": "Rollback deletes {{count}} TODO items",
  "remote.rollback.todoToggle": "Show/hide the TODO list",
  "remote.rollback.workflowNotice":
    "{{count}} WorkFlow(s) will be aborted (if still running) and deleted together with their node conversations; restoring files also reverts the nodes' edits",
  "remote.rollback.memoryOption":
    "Also delete the {{count}} project memories saved by the rolled-back rounds (leave unchecked to keep them)",
  "remote.rollback.memoryToggle": "Show/hide the memory list",
  "remote.rollback.done": "Rollback complete",
  "remote.rollback.ended": "Rollback ended on the desktop",

  // Action sheet
  "remote.actions.image": "Add image",
  "remote.actions.file": "Add file",
  "remote.actions.newChat": "New chat",
  "remote.actions.commands": "Command panel",
  "remote.mode.enabled": "{{name}} enabled",
  "remote.mode.disabled": "{{name}} disabled",
  "remote.mode.lockedRunning":
    "Session running — modes are locked until it ends",
  "remote.modes.sectionTitle": "Modes",
  "remote.modes.yolo": "YOLO",
  "remote.modes.lite": "Lite",
  "remote.modes.worktree": "WorkTree",
  "remote.modes.workflow": "WorkFlow",
  "remote.modes.goal": "Goal",
  "remote.appSettings.sectionTitle": "App",
  "remote.appSettings.toolCorrection": "Auto tool correction",

  // Attachments
  "remote.attachments.maxCount": "Up to 4 attachments at a time",
  "remote.attachments.imageOnly": "Only PNG, JPEG, GIF and WebP are supported",
  "remote.attachments.imageTooLarge": "Images must not exceed 10 MiB",
  "remote.attachments.fileTooLarge": "Files must not exceed 20 MiB",
  "remote.attachments.remove": "Remove",
  "remote.attachments.uploading": "Uploading",
  "remote.attachments.failed": "Failed",
  "remote.attachments.ready": "Ready",
  "remote.attachments.uploadingNotice": "Attachments are still uploading",
  "remote.attachments.failedNotice": "Remove failed attachments and try again",

  // Notices
  "remote.notice.newChatCreated": "New chat created",
  "remote.notice.newChatPending": "New chat is still processing",
  "remote.notice.switchingConversation": "Switching conversation",
  "remote.notice.conversationSelected": "Conversation switched",
  "remote.notice.settingsUpdated": "Settings updated",
  "remote.notice.themeUpdated": "Appearance updated",
  "remote.notice.skillEnabled": "Skill enabled",
  "remote.notice.skillDisabled": "Skill disabled",
  "remote.notice.mcpUpdated": "MCP settings updated",
  "remote.notice.approved": "Tool execution approved",
  "remote.notice.rejected": "Tool execution rejected",
  "remote.notice.answered": "Answer submitted",
  "remote.notice.cancelled": "Answer cancelled",
  "remote.notice.sent": "Sent to Snow",
  "remote.notice.queued": "Queued for sending",
  "remote.notice.stopping": "Stopping",
  "remote.notice.commandRunning": "Running command…",
  "remote.notice.commandExecuted": "Command executed",
  "remote.notice.compactingWait":
    "Compaction is still running, check messages later",
  "remote.notice.compacted": "Context compaction finished",

  // Panel shell
  "remote.panels.commands.title": "Commands",
  "remote.panels.commands.search": "Search commands…",
  "remote.panels.permissions.title": "Permission summary",
  "remote.panels.role.title": "Role summary",
  "remote.panels.sensitive.title": "Sensitive command rules",
  "remote.panels.codebase.title": "Codebase summary",
  "remote.panels.review.title": "Review summary",
  "remote.panels.model.title": "Model & reasoning",
  "remote.panels.skills.title": "Skills",
  "remote.panels.mcp.title": "MCP",
  "remote.panels.theme.title": "Appearance",
  "remote.panels.changes.title": "Changes summary",
  "remote.panel.close": "Close panel",
  "remote.loading.default": "Loading…",
  "remote.loading.permissions": "Loading permissions…",
  "remote.loading.role": "Loading role…",
  "remote.loading.sensitive": "Loading rules…",
  "remote.loading.codebase": "Loading codebase status…",
  "remote.loading.review": "Loading review status…",
  "remote.loading.skills": "Loading Skills…",
  "remote.loading.mcp": "Loading MCP…",
  "remote.loading.changes": "Loading changes…",
  "remote.error.retry": "Please try again later",
  "remote.error.loadPermissions": "Failed to load permissions",
  "remote.error.loadRole": "Failed to load role",
  "remote.error.loadSensitive": "Failed to load rules",
  "remote.error.loadCodebase": "Failed to load codebase",
  "remote.error.loadReview": "Failed to load review status",
  "remote.error.loadSkills": "Failed to load Skills",
  "remote.error.loadMcp": "Failed to load MCP",
  "remote.error.loadChanges": "Failed to load changes",
  "remote.empty.noCommands": "No commands available",
  "remote.listSeparator": ", ",

  // Skills
  "remote.skills.search": "Search skills…",
  "remote.skills.empty": "No matching skill",
  "remote.skills.toolsUndeclared": "Not declared",
  "remote.skills.locationProject": "Project",
  "remote.skills.locationGlobal": "Global",
  "remote.skills.sourceAgents": "Agents",
  "remote.skills.sourceSnow": "Snow",
  "remote.skills.detailSource": "Source",
  "remote.skills.detailTools": "Allowed tools",
  "remote.skills.detailPermission": "Phone permissions",
  "remote.skills.detailPermissionNote":
    "View details and toggle only; skill files are never read",
  "remote.skills.enable": "Enable {{name}}",
  "remote.skills.disable": "Disable {{name}}",

  // MCP
  "remote.mcp.empty": "No MCP servers in this project",
  "remote.mcp.toolFallback": "MCP tool",
  "remote.mcp.sourceProject": "Project",
  "remote.mcp.sourceGlobal": "Global",
  "remote.mcp.unavailableSuffix": " · unavailable",

  // Permission summary
  "remote.permissions.projectApproved": "Project-approved tools",
  "remote.permissions.globalApproved": "Global-approved tools",
  "remote.permissions.readonly": "Read-only tools",
  "remote.permissions.readonlyCount": "{{count}} total",
  "remote.permissions.yolo": "YOLO mode",
  "remote.permissions.yoloOn":
    "Enabled; permissions cannot be changed from the phone",
  "remote.permissions.yoloOff": "Disabled",
  "remote.permissions.none": "None",

  // Role summary
  "remote.role.source": "Source",
  "remote.role.sourceProject": "Current project",
  "remote.role.sourceSsh": "SSH project",
  "remote.role.sourceGlobal": "Global",
  "remote.role.sourceNone": "Not set",
  "remote.role.status": "Status",
  "remote.role.exists": "Present",
  "remote.role.missing": "Not found",
  "remote.role.charCount": "{{count}} characters",
  "remote.role.preview": "Preview",
  "remote.role.previewNone": "None",
  "remote.role.readonlyNote": "The phone provides a read-only summary only",

  // Sensitive command rules
  "remote.sensitive.empty": "No sensitive command rules",
  "remote.sensitive.scopeProject": "Project",
  "remote.sensitive.scopeGlobal": "Global",
  "remote.sensitive.inheritedSuffix": " · inherited",
  "remote.sensitive.presetSuffix": " · preset",
  "remote.sensitive.enabled": "enabled",
  "remote.sensitive.disabled": "disabled",

  // Codebase summary
  "remote.codebase.index": "Index",
  "remote.codebase.indexed": "Built",
  "remote.codebase.notIndexed": "Not built",
  "remote.codebase.fileCount": "{{count}} files",
  "remote.codebase.scale": "Scale",
  "remote.codebase.chunkCount": "{{count}} chunks",
  "remote.codebase.features": "Features",
  "remote.codebase.enabled": "Enabled",
  "remote.codebase.disabled": "Disabled",
  "remote.codebase.agentReview": "Agent Review {{state}}",
  "remote.codebase.rerank": "Reranking {{state}}",
  "remote.codebase.switchOn": "on",
  "remote.codebase.switchOff": "off",
  "remote.codebase.note":
    "The phone shows status only; run scans and change scopes on the desktop",

  // Review summary
  "remote.review.repository": "Repository",
  "remote.review.available": "Ready",
  "remote.review.unavailable": "Unavailable",
  "remote.review.noBranch": "No branch",
  "remote.review.changes": "Changes",
  "remote.review.staged": "Staged {{count}}",
  "remote.review.unstaged": "Unstaged {{count}}",
  "remote.review.untracked": "Untracked {{count}}",
  "remote.review.note": "Start reviews on the desktop",

  // Changes summary
  "remote.changes.summary": "{{count}} file(s) modified in this session",
  "remote.changes.summaryMain": "Main agent {{count}}",
  "remote.changes.summarySub": "Sub-agents {{count}}",
  "remote.changes.empty": "No file changes in this conversation",
  "remote.changes.kindCreate": "Created",
  "remote.changes.kindEdit": "Modified",
  "remote.changes.kindDelete": "Deleted",
  "remote.changes.agentSub": "Sub-agent",
  "remote.changes.agentMain": "Main agent",

  // Message rendering
  "remote.message.thinkingActive": "Snow is thinking",
  "remote.message.thinkingDone": "Thought for {{seconds}}s",
  "remote.message.thinkingView": "View reasoning",
  "remote.tool.arguments": "Arguments",
  "remote.tool.stdout": "Output",
  "remote.tool.stderr": "Error",
  "remote.tool.result": "Result",
  "remote.message.imageAlt": "Image",
  "remote.message.attachment": "Attachment",
  "remote.message.folder": "Folder",
  "remote.message.file": "File",
  "remote.message.reference": "Reference",

  // Authorization / question cards
  "remote.interaction.authRequired": "Authorization needed · {{name}}",
  "remote.interaction.view": "View",
  "remote.interaction.collapse": "Collapse",
  "remote.interaction.expandDetail": "Show full text",
  "remote.interaction.collapseDetail": "Show less",
  "remote.interaction.authFallback": "Snow requests to run this tool",
  "remote.interaction.rejectPlaceholder": "Reason (optional)",
  "remote.interaction.reject": "Reject",
  "remote.interaction.approve": "Allow once",
  "remote.interaction.questionTitle": "Your confirmation is needed",
  "remote.interaction.answerPlaceholder": "You can also type your own answer",
  "remote.interaction.cancel": "Cancel",
  "remote.interaction.submitAnswer": "Submit answer",

  // Thread sheet
  "remote.threads.title": "Select conversation",
  "remote.threads.close": "Close",
  "remote.threads.empty": "No conversations",
  "remote.threads.otherWorkspace": "Other workspace",
  "remote.threads.untitled": "Untitled conversation",
  "remote.threads.noPreview": "No messages yet",
  "remote.threads.newConversation": "New chat",
  "remote.threads.noWorkspace": "No workspace selected",
  "remote.threads.loadMore": "Load more",
  "remote.threads.loading": "Loading…",
  "remote.threads.loadMoreFailed": "Failed to load more conversations",
  "remote.threads.subAgent": "Sub-agent",
  "remote.threads.workflowNode": "Workflow node",
  "remote.threads.workflowSession": "Workflow session",
  "remote.threads.forkedSession": "Forked chat",
  "remote.threads.hasSubAgents": "Has sub-agents",
  "remote.threads.statusAttention": "Needs action",
  "remote.threads.statusStreaming": "Running",
  "remote.threads.statusPaused": "Paused",
  "remote.threads.statusCompleted": "Completed",
  "remote.threads.statusFailed": "Failed",
  "remote.threads.expandChildren": "Expand child sessions",
  "remote.threads.collapseChildren": "Collapse child sessions",
  "remote.threads.expandGroup": "Expand project conversations",
  "remote.threads.collapseGroup": "Collapse project conversations",

  // Relative time
  "remote.time.justNow": "Just now",
  "remote.time.minutes": "{{count}} min",
  "remote.time.hours": "{{count}} h",
  "remote.time.days": "{{count}} d",

  // Appearance
  "remote.theme.system": "System",
  "remote.theme.systemHint": "Follow the phone's dark mode",
  "remote.theme.light": "Light",
  "remote.theme.lightHint": "Light background and dark text",
  "remote.theme.dark": "Dark",
  "remote.theme.darkHint": "Dark background and low brightness",

  // Toolbar chips
  "remote.chips.mode": "Mode: {{value}}",
  "remote.chips.modeStandard": "Standard",
  "remote.chips.context": "Context {{value}}",
  "remote.chips.empty": "—",

  // Model panel (same hierarchy as the desktop ModelSelector)
  "remote.model.notSelected": "Not selected",
  "remote.model.thinking": "Thinking strength",
  "remote.model.fastMode": "Fast Mode",
  "remote.model.fastModeOff": "Off",
  "remote.model.fastModeFast": "Fast",
  "remote.model.fastModeUltrafast": "UltraFast",
  "remote.model.menuModel": "Model",
  "remote.model.menuProfile": "Select API provider",
  "remote.model.searchModels": "Search models…",
  "remote.model.searchProfiles": "Search providers…",
  "remote.model.back": "Back",
  "remote.model.noMatches": "No matches",
  "remote.model.empty": "Nothing available",
  "remote.model.unavailable": "Desktop unavailable — open a regular chat",

  // Image lightbox
  "remote.lightbox.close": "Close image preview",
  "remote.lightbox.alt": "Image preview",

  // WorkFlow card (workflow-generate / workflow-resume tool calls)
  "remote.workflow.title": "WorkFlow",
  "remote.workflow.status.idle": "Ready",
  "remote.workflow.status.running": "Running",
  "remote.workflow.status.completed": "Completed",
  "remote.workflow.status.failed": "Paused",
  "remote.workflow.status.replied": "Feedback sent",
  "remote.workflow.dependsOn": "After: {{names}}",
  "remote.workflow.execute": "Execute",
  "remote.workflow.resume": "Resume",
  "remote.workflow.idleHint":
    "Execute when ready, or send feedback and Snow will redesign the flow",
  "remote.workflow.runningHint":
    "Workflow is running — node progress updates live",
  "remote.workflow.completedHint": "Workflow completed",
  "remote.workflow.failedHint": "Workflow paused on the failed node: {{name}}",
  "remote.workflow.failedHintFallback": "Workflow paused on a failed node",
  "remote.workflow.resumeHint":
    "Unfinished progress found — resume to skip completed nodes, or ask Snow in the chat to continue the failed node",
  "remote.workflow.resumeReadonly": "Resumed node status (read-only)",
  "remote.workflow.settledHint": "This flow is settled — ask Snow to redesign",
  "remote.workflow.repliedHint":
    "Feedback submitted — Snow will redesign the flow",
  "remote.workflow.replyLabel": "Not satisfied? Describe your changes:",
  "remote.workflow.replyPlaceholder":
    "e.g. split step 2 into two steps and add tests",
  "remote.workflow.replySubmit": "Send feedback",
  "remote.workflow.repliedFeedback": "Submitted feedback",
  "remote.workflow.empty": "No runnable nodes yet",
  "remote.workflow.canvasHint":
    "Drag to pan · pinch to zoom · tap a node to open its chat",
  "remote.workflow.fitView": "Fit view",
  "remote.workflow.nodeOpen": "Open node chat",
  "remote.workflow.started": "Workflow started",
  "remote.workflow.replied": "Feedback submitted",

  // 工具卡片词典（i18n/lang/tools/* 聚合，键前缀 remote.toolCall.*）
  ...toolsEn,
};
