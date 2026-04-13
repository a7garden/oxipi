# InteractiveMode Method Groups

This document describes the method organization in `interactive-mode.ts` (4700+ lines).
Methods are grouped by responsibility for planned refactoring.

## Current Status (2026-04-12)

### Completed Separations
- **types.ts**: Core types, helper functions, abstract interfaces for DI
  - `InteractiveModeOptions`
  - `Expandable` interface
  - `SessionStore`, `SettingsStore` interfaces (for DI)
  - `SkillInfo`, `LoadSkillsOptions`, `LoadedSkills` types
  - `normalizeSlackMessageText()` helper (for mom integration)
  - `formatSkillsForPrompt()` helper (for mom integration)
  - Keybinding type definitions

### Remaining in interactive-mode.ts
- 4700 lines (class definition with all methods)
- All command handlers, event handlers, UI components
- Lifecycle methods (init, start, shutdown)

## Group 1: Initialization & Setup
- `setupAutocomplete()`
- `initializeCommands()`
- `getRegisteredToolDefinition()`
- `setupExtensionShortcuts()`
- `setupKeyHandlers()`
- `setupEditorSubmitHandler()`

## Group 2: Event Handling
- `handleEvent()` - Main event switch (lines 2299-2853)
- `handleRuntimeSessionChange()`
- `handleFatalRuntimeError()`
- `handleClipboardImagePaste()`
- `handleFollowUp()`
- `handleDequeue()`
- `handleRuntimeSessionChange()`

## Group 3: Command Handlers
- `handleModelCommand()`
- `handleReloadCommand()`
- `handleExportCommand()`
- `handleImportCommand()`
- `handleShareCommand()`
- `handleCopyCommand()`
- `handleClearCommand()`
- `handleBashCommand()`
- `handleCompactCommand()`
- `handlePlannerCommand()`
- `handleResumeSession()`
- `handleNameCommand()`
- `handleSessionCommand()`
- `handleChangelogCommand()`
- `handleHotkeysCommand()`
- `handleDebugCommand()`
- `handleCtrlC()`, `handleCtrlD()`, `handleCtrlZ()`

## Group 4: UI Display & Selection
- `showStartupNoticesIfNeeded()`
- `updateTerminalTitle()`
- `showLoadedResources()`
- `showModelSelector()`
- `showTreeSelector()`
- `showOAuthSelector()`
- `showLoginDialog()`
- `showExtensionSelector()`
- `showExtensionInput()`
- `showExtensionEditor()`
- `showExtensionNotify()`
- `showExtensionError()`
- `showExtensionConfirm()`
- `showExtensionCustom()`
- `showStatus()`
- `showError()`, `showWarning()`
- `showSelector()`
- `showSettingsSelector()`
- `showUserMessageSelector()`
- `updateAvailableProviderCount()`

## Group 5: Session Context & Chat
- `renderCurrentSessionState()`
- `renderSessionContext()`
- `rebuildChatFromMessages()`
- `addMessageToChat()`
- `getUserMessageText()`
- `updatePendingMessagesDisplay()`
- `restoreQueuedMessagesToEditor()`
- `queueCompactionMessage()`
- `getAllQueuedMessages()`

## Group 6: Model & Provider
- `findExactModelMatch()`
- `getModelCandidates()`
- `cycleModel()`

## Group 7: Extension Management
- `bindCurrentSessionExtensions()`
- `applyRuntimeSettings()`
- `renderWidgets()`
- `renderWidgetContainer()`
- `setExtensionHeader()`
- `setExtensionStatus()`
- `setHiddenThinkingLabel()`
- `clearExtensionWidgets()`
- `resetExtensionUI()`
- `clearExtensionTerminalInputListeners()`
- `createExtensionUIContext()`

## Group 8: Lifecycle
- `init()` - Main initialization
- `start()`
- `shutdown()`
- `checkShutdownRequested()`
- `flushCompactionQueue()`
- `abort()`

## Refactoring Plan

### Phase A: Extract Types (DONE)
- Move `InteractiveModeOptions`, `Expandable`, helpers to `types.ts`

### Phase B: Extract Command Handlers
- Create `command-handlers.ts` with command processing logic
- Keep reference in InteractiveMode

### Phase C: Extract Event Handlers
- Create `event-handlers.ts` for `handleEvent()` switch cases
- Each case becomes a separate handler function

### Phase D: Extract UI Components
- Create `ui-components.ts` for display/selection logic
- Extract widget rendering

### Phase E: Extract Session/Chat Logic
- Create `session-display.ts` for chat rendering
- Extract message processing
