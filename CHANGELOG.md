# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.0] - 2026-07-04

Initial release: a standalone TypeScript ACP server bridging the headless
ZCode app-server to ACP-compatible editors (Zed, JetBrains).

### Added
- ZCode subprocess client with reader-loop multiplexing and process-group
  isolation.
- Event-stream listener (`session/subscribe` + `session/event`).
- Event translators + projection differ with dual-path deduplication.
- Bash terminal protocol (2-notification split: `terminal_output` +
  `terminal_exit`).
- Interaction adapter: `requestPermission`, `ExitPlanMode`, `AskUserQuestion`
  — preferring `elicitation/create` (form mode) when the client declares
  `clientCapabilities.elicitation.form`, falling back to per-question
  `session/request_permission`.
- Session lifecycle + extensions: `fork`, `rewind`, `rewindCascade`, `goal`,
  `compact`, `steer`, `cancelBackgroundTask`, `setMode`, `setModel`,
  `setThoughtLevel`, `updateRuntimeModelConfig`.
- Slash command interception (`/compact`, `/goal`, `/fork`, `/rewind`,
  `/steer`, `/model`, `/mode`, `/thought`).
- `configOptions` + runtime model overlay (resumes use the active provider's
  OAuth creds).
- tasks-index sqlite sync (Node ≥ 22 `node:sqlite`, best-effort).
- Slash commands advertised 50ms after the session response so the client
  state machine is ready (`sendAvailableCommandsDeferred`).
- Interaction request timeout (600s) with turn-cancel polling — a user
  pressing stop during a popup no longer waits for the full client-response
  window.
- Initial `usage_update` on `session/resume` and `session/load`.
- ESLint + `lint` script, `typecheck` script, GitHub Actions CI.
- `CONTRIBUTING.md`, `CHANGELOG.md`, full `docs/` (Architecture, Protocol,
  Development, Troubleshooting).

### Fixed
- `buildSnapshot` flattens `todoGroups` as a **list** (it was read as a single
  object); the plan list is no longer empty on `session/load` and
  `PlanUpdate` is correctly emitted at turn completion.
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
- `engines.node` is `>=22.0.0` (the bridge requires `node:sqlite`).
- `package.json` declares `files`, `repository`, `keywords`, `types`,
  `packageManager`.
- Deferred command notifications and the cancel poll use `unref()` timers so
  they cannot keep the event loop alive.
