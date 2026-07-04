# zcode-acp-server

A standalone [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) server that bridges the headless **ZCode** app-server to ACP-compatible editors such as [Zed](https://zed.dev) and JetBrains IDEs.

The server launches the ZCode headless app-server (`zcode app-server --stdio`) as a subprocess, translates its internal event stream into ACP `session/update` notifications, and bridges ACP `session/request_permission` back to ZCode's interaction channel — so an editor gets a first-class, native coding-agent experience.

## Status

Early in-development. Core scaffolding is in place; features are landing incrementally. See the project board for progress.

## Requirements

- Node.js ≥ 18.17 (uses `node:sqlite` probe for the bundled runtime; the ZCode CLI itself requires Node ≥ 22)
- The `zcode` CLI installed and on `PATH` (or pointed at via `ZCODE_BIN`)
- ZCode credentials at `~/.zcode/v2/config.json` (created by the ZCode app)

## Install

```bash
# from this repo
pnpm install
pnpm build
```

The compiled entry point is `dist/index.js`. It is also exposed as the `zcode-acp-server` bin.

## Configure Zed

Add the server to Zed as an external agent. In `~/.config/zed/settings.json`:

```jsonc
{
  "assistant": {
    "entitled": true
  },
  "acp": {
    "agents": [
      {
        "name": "zcode",
        "command": { "path": "node", "args": ["/absolute/path/to/zcode-acp-server/dist/index.js"] }
      }
    ]
  }
}
```

Restart Zed and pick **ZCode** from the agent dropdown.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ZCODE_BIN` | `zcode` | Path to the ZCode CLI binary or its `.cjs` entry |
| `ZCODE_NODE` | _(discovered)_ | Explicit Node binary to run `ZCODE_BIN` with (must support `node:sqlite`) |
| `ZCODE_MODEL` | _(from config)_ | Override the active model id |
| `ZCODE_BASE_URL` | _(from config)_ | Override the provider base URL |

## Develop

```bash
pnpm install
pnpm build       # tsc → dist/
pnpm test        # vitest
pnpm format      # prettier on src/
```

## Architecture

The server is organised in layers that mirror the ACP protocol:

- `backend/` — ZCode subprocess client: spawn, reader-loop multiplexer, event-stream listener, sync request/response
- `translators/` — turn ZCode events into ACP `session/update` notifications (event streaming + snapshot diff)
- `interaction/` — bridge ZCode `interaction/*` server requests to ACP `session/request_permission` (tool auth, ExitPlanMode, AskUserQuestion)
- `handlers/` — ACP method handlers (`session/new`, `session/prompt`, ...) and the turn engine
- `config/` — model / mode / thought-level configOptions and runtime model switching
- `server.ts` — shared state and handler registration
- `index.ts` — stdio wiring via the ACP SDK

## License

Apache-2.0. This project follows the same license as the upstream ACP specification.
