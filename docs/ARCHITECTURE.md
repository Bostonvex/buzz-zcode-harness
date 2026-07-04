# zcode-acp-server Architecture

## Overview

`zcode-acp-server` bridges the headless ZCode CLI (`zcode app-server --stdio`) to
ACP (Agent Client Protocol) compatible editors. It is the translation layer
between ZCode's internal JSON-RPC event stream and the standard ACP protocol.

## Layered Architecture

```
application-client (Zed / JetBrains)
  session/update
       |
       v
zcode-acp-server (stdio JSON-RPC ACP)
  |-- handlers/     session, extensions, dispatch, server-requests, io, slash
  |-- translators/    event-translator, projection-differ, tool-helpers
  |-- interaction/    adapter
  |-- config/         options, runtime-model, model-cache
  |-- backend/        client, listener, types
  |-- server.ts       ZcodeAcpServer
       |
       v
zcode app-server --stdio (line-delimited JSON)
```

## Core Data Flow

### 1. Session lifecycle

```
session/new → session/create → register EventListener
     |
prompt request → session/send → EventTranslator translates → dispatchEvent
     |                                  |
  end_turn / cancelled         session/update notification
```

### 2. Event stream subscription

```
EventStreamListener.subscribe()
  |
session/subscribe (deliveryKind: "desktop-continuous")
  |
ZCode pushes session/event → handleEvent()
  |
pollEvent() consumes → EventTranslator.translate()
```

### 3. Dual-path event handling

#### Real-time path (EventTranslator)
- Listens to zcode `session/event` pushes
- Translates each event to an ACP `session/update` in real time
- Maintains `seenToolIds` to avoid duplicates

#### Snapshot path (ProjectionDiffer)
- On turn completion, builds a snapshot from `session/messages` + `session/read`
- Diffs two snapshots to produce new events (PlanUpdate / TextDelta / ToolCallNew, etc.)
- Used for turn-completion triage and stall recovery

### 4. Dual-path deduplication

```
EventTranslator (real-time path)
  ├── seenToolIds: Set<string>
  └── turnDone: boolean
         |
         v
ProjectionDiffer (snapshot path)
  ├── seenToolIds: Set<string>
  ├── lastToolStatus: Map<string, string>
  └── seenMessageIds: Set<string>
         |
         v
    dispatchEvent (single exit point)
```

Key: **`seenToolIds` synchronization**

In `session.ts:550`, after the event path finishes processing, the state is
synced to the differ:
```typescript
for (const seenId of translator.seenToolIds) {
  differ.markToolSeen(seenId);
}
```

This ensures the snapshot diff does not re-emit tools already handled by the
event path, preventing Bash terminal output from being overwritten by a
content-less ToolCallNew.

## Module Responsibilities

### `backend/` — ZCode process communication

| File | Responsibility |
|------|------|
| `client.ts` | Spawn/manage the zcode subprocess, reader-loop, request/response multiplexing |
| `listener.ts` | EventStreamListener (subscribe/consume the event stream) and TurnMonitor (snapshot polling) |
| `types.ts` | ZCode JSON-RPC message type definitions |

### `translators/` — Event translation

| File | Responsibility |
|------|------|
| `event-translator.ts` | Translate zcode events to InternalEvent (real-time path) |
| `projection-differ.ts` | Diff two snapshots to produce InternalEvent (snapshot path) |
| `tool-helpers.ts` | Tool-related pure functions: title generation, output rendering, diff parsing, location extraction |
| `types.ts` | InternalEvent union type and plan entry builders |

### `handlers/` — ACP method handling

| File | Responsibility |
|------|------|
| `session.ts` | session/new/list/resume/load/prompt/set_config_option/cancel |
| `extensions.ts` | fork/rewind/rewindCascade/goal/compact/steer/cancelBackgroundTask/setModel/setMode/setThoughtLevel |
| `dispatch.ts` | dispatchEvent single exit point: InternalEvent → ACP session/update |
| `server-requests.ts` | Handle zcode interaction/* requests (tool auth, ExitPlanMode, AskUserQuestion), protocol negotiation routing |
| `io.ts` | ACP notification helpers (including `sendAvailableCommandsDeferred` deferred notification) |
| `slash.ts` | Interception of `/`-prefixed commands (/compact /goal /fork /rewind /steer /model /mode /thought) |

### `interaction/` — Interaction bridging

| File | Responsibility |
|------|------|
| `adapter.ts` | Conversion adapter from zcode interaction requests to ACP (requestPermission + elicitation form) |

### `config/` — Configuration management

| File | Responsibility |
|------|------|
| `options.ts` | configOptions / modes construction, set_config_option dispatch |
| `runtime-model.ts` | runtimeModel overlay construction and application |
| `model-cache.ts` | Model ID cache and usage initialization |

## Key State Machines

### Turn state

```
          subscribe
              |
         turn.started
              |
    +---------------------+
    | model.streaming     |
    | tool.updated        |
    | session.updated     |
    +---------------------+
              |
    +---------------------+
    | turn.completed      | -> end_turn
    | turn.failed         | -> error
    | turn.cancelled      | -> cancelled
    | timeout (120s)      | -> max_turn_requests
    | manual cancel       | -> cancelled
    +---------------------+
```

### Tool lifecycle

```
scheduled  ->  started  ->  progress  ->  result/error
   |            |            |
ToolCallNew  status=in_progress  output (stdoutTail)
   |
(seenToolIds.add)
```

## Interaction Protocol Negotiation

ZCode `interaction/*` requests are routed to different ACP client interaction
mechanisms via protocol negotiation:

```
zcode interaction request received
  │
  ├─ Tool auth (interaction/requestPermission)
  │     └─ Always uses session/request_permission (its native purpose)
  │
  ├─ ExitPlanMode (interaction/requestUserInput + plan_approval)
  │     ├─ Client supports elicitation.form → elicitation/create (approve/reject form)
  │     └─ Otherwise → session/request_permission (fallback)
  │
  └─ AskUserQuestion (interaction/requestUserInput)
        ├─ Client supports elicitation.form → elicitation/create (single form)
        └─ Otherwise → per-question session/request_permission (fallback)
```

**Key**: `server.supportsElicitationForm()` is detected at `initialize` time from
`clientCapabilities.elicitation.form`. Tool auth always goes through
request_permission, since that is its native purpose.

## Deferred Notification Mechanism

The `available_commands_update` notification must be sent **after** the session
response; otherwise the client's session state machine is not yet ready and
drops the notification, leaving the `/` completion menu empty.

```
session/new|resume|load handler
  │
  ├─ call newSession()/resumeSession()/loadSession()
  │
  ├─ sendAvailableCommandsDeferred(cx, sid, SLASH_COMMANDS)
  │     └─ enqueue, send after 50ms (fire-and-forget)
  │
  └─ return response
       │
       └─ after the response is written to stdout, the 50ms timer fires sendAvailableCommands
```

`sendAvailableCommandsDeferred` (`io.ts`) encapsulates the 50ms delay logic,
mirroring the Python bridge's `_pending_post_notifs` queue +
`_drain_post_notifs` mechanism.

## Design Decisions

### Why a dual path?

| Scenario | Real-time path | Snapshot path |
|------|---------|----------|
| Normal streaming | Low latency | Must wait for turn end |
| Lost events | Loses data | Recovers from snapshot |
| Deduplication | seenToolIds | seenMessageIds + markToolSeen() |
| Turn-completion triage | Not triggered | PlanUpdate / usage_update |

### Why no polling fallback?

ZCode CLI 0.14.5 ~ 0.14.7 used `session/read` polling to emulate streaming.
0.14.8+ introduced `session/subscribe` event push, which has lower latency and
is more reliable. This project supports only 0.14.8+ and has removed the
polling fallback code.

### Why does ProjectionDiffer need to persist across turns?

- `seenMessageIds`: prevents historical messages from being re-emitted after resume
- `lastToolStatus` + `seenToolIds`: ensures tool state is not lost across turns
- `lastUsage`: avoids duplicate usage_update pushes
- `lastPlanSig`: emits only when the plan changes
