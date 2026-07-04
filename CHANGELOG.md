# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Elicitation form path: `AskUserQuestion` and `ExitPlanMode` now prefer
  `elicitation/create` (form mode) when the client declares
  `clientCapabilities.elicitation.form`, falling back to per-question
  `session/request_permission`.
- `sendAvailableCommandsDeferred`: slash commands are advertised 50ms after the
  session response so the client state machine is ready.
- `supportsElicitationForm()` capability detection.
- Interaction requests (permission / elicitation) now carry a `toolCallId`
  session-scope so the client can associate the form with its tool call.
- Interaction request timeout (600s) and turn-cancel polling — a user pressing
  stop during a popup no longer waits for the full client-response window.
- Initial `usage_update` on `session/resume` (parity with the Python bridge).
- ESLint + `lint` script, `typecheck` script, GitHub Actions CI.
- `CONTRIBUTING.md`, `CHANGELOG.md`, full `docs/` (Architecture, Protocol,
  Development, Troubleshooting).

### Fixed
- `buildSnapshot` now flattens `todoGroups` as a **list** (it was read as a
  single object); the plan list is no longer empty on `session/load` and
  `PlanUpdate` is correctly emitted at turn completion.
- `session/resume` emits the initial `usage_update` so the context bar shows
  immediately.
- Cached reannounce replies use `sendReply` (`{id, result}`) instead of
  `notify` (`{method, params}`).
- Shutdown triggers on stdin-close and backend-death (no orphan processes).
- `thought` configOption metadata: category `thought_level`, lowercase options.
- `set_config_option` returns the full `configOptions` array.
- Usage fallback uses `contextUsed || totalTokenCount || 0` (not `??`).
- `pollEvent` no longer delivers events to settled (zombie) waiters.
- Async backend `close()` correctly reaps the process group.
- Turn completion runs `differ.diff()` to emit `PlanUpdate`.
- `Edit`/`Write` structured diffs are dispatched immediately.
- Stable plan signatures (sorted keys) prevent spurious `PlanUpdate`.

### Changed
- `engines.node` corrected to `>=22.0.0` (the bridge requires `node:sqlite`).
- `package.json` declares `files`, `repository`, `keywords`, `types`, etc.
- Deferred command notifications and the cancel poll use `unref()` timers so
  they cannot keep the event loop alive.
- Removed dead `PendingTurn.permResponses` field (the ACP SDK `cx.request`
  supersedes it).

## [0.1.0] - initial port

Full port of the Python ACP bridge to a standalone TypeScript package:
- ZCode subprocess client with reader-loop multiplexing
- Event-stream listener (`session/subscribe`)
- Event translators + projection differ (dual-path dedup)
- Bash terminal protocol (2-notification split)
- Interaction adapter (`requestPermission`, `ExitPlanMode`, `AskUserQuestion`)
- Session lifecycle + extensions (`fork`, `rewind`, `goal`, `compact`, `steer`,
  `setMode`, `setModel`, `setThoughtLevel`, ...)
- Slash command interception
- `configOptions` + runtime model overlay
- tasks-index sqlite sync
