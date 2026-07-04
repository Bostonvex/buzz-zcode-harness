# ZCode JSON-RPC Protocol

This document describes the internal JSON-RPC protocol between zcode-acp-server
and the ZCode CLI.

## Protocol Overview

ZCode communicates over stdio using **line-delimited JSON**. The message format
resembles JSON-RPC, but **does not include the `jsonrpc` field**.

### Message classification

Messages are classified by the presence of `id` and `method`:

| Combination | Type | Direction |
|------|------|------|
| `id` + no `method` | Response | zcode -> bridge |
| `id` + `method` | Request | bridge -> zcode or zcode -> bridge |
| `method` + no `id` | Notification | bidirectional |

### Request format

```json
{
  "id": 1,
  "method": "session/create",
  "params": {
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    },
    "mode": "yolo"
  }
}
```

### Response format

```json
{
  "id": 1,
  "result": {
    "session": {
      "sessionId": "sess_abc123",
      "title": "your prompt text..."
    }
  }
}
```

### Error format

```json
{
  "id": 1,
  "error": {
    "message": "prompt is running",
    "code": 1308
  }
}
```

### Notification format

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 42,
    "type": "turn.started",
    "payload": {}
  }
}
```

## Session Lifecycle Methods

### `session/create`

Create a new session.

**Request:**
```json
{
  "id": 1,
  "method": "session/create",
  "params": {
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    },
    "mode": "yolo"
  }
}
```

**Response:**
```json
{
  "id": 1,
  "result": {
    "session": {
      "sessionId": "sess_abc123",
      "title": "",
      "traceId": "trace_xyz789"
    }
  }
}
```

### `session/list`

List all sessions.

**Request:**
```json
{
  "id": 2,
  "method": "session/list",
  "params": {
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    }
  }
}
```

### `session/resume`

Resume an existing session.

**Request:**
```json
{
  "id": 3,
  "method": "session/resume",
  "params": {
    "sessionId": "sess_abc123",
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    }
  }
}
```

### `session/send`

Send a prompt.

**Request:**
```json
{
  "id": 4,
  "method": "session/send",
  "params": {
    "sessionId": "sess_abc123",
    "content": "your prompt text"
  }
}
```

**Response:**
```json
{
  "id": 4,
  "result": {
    "accepted": true
  }
}
```

### `session/stop`

Stop the current turn (fire-and-forget).

```json
{
  "method": "session/stop",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

### `session/read`

Read the session state and projection.

**Request:**
```json
{
  "id": 5,
  "method": "session/read",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

**Response:**
```json
{
  "id": 5,
  "result": {
    "projection": {
      "status": "idle",
      "contextUsed": 1234,
      "contextWindow": 32000,
      "totalTokenCount": 5678
    },
    "settings": {
      "mode": { "current": "yolo" },
      "model": { "current": { "modelId": "GLM-5.2" } },
      "thoughtLevel": { "current": "high" }
    },
    "todos": [
      { "content": "Implement login", "status": "pending", "priority": "high" }
    ]
  }
}
```

### `session/messages`

Fetch the session's historical messages.

**Request:**
```json
{
  "id": 6,
  "method": "session/messages",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

## Event Stream Subscription

### `session/subscribe`

Subscribe to a session's event push.

**Request:**
```json
{
  "id": 7,
  "method": "session/subscribe",
  "params": {
    "sessionId": "sess_abc123",
    "deliveryKind": "desktop-continuous",
    "includeSnapshot": true,
    "afterSeq": 0
  }
}
```

**Response:**
```json
{
  "id": 7,
  "result": {
    "eventSeq": 42,
    "snapshot": {
      "projection": { ... },
      "messages": [ ... ]
    }
  }
}
```

## Event Types

After subscribing, zcode pushes events via `session/event` notifications:

### `turn.started`

The turn has started.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 43,
    "type": "turn.started",
    "payload": {}
  }
}
```

### `model.streaming`

Model streaming output.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 44,
    "type": "model.streaming",
    "payload": {
      "kind": "text_delta",
      "delta": "this code..."
    }
  }
}
```

`kind` can be:
- `text_delta`: text delta
- `reasoning_delta`: reasoning text delta
- `tool_call`: tool call declaration (caches toolName and input)

### `tool.updated`

Tool status update.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 45,
    "type": "tool.updated",
    "payload": {
      "kind": "scheduled",
      "toolCallId": "call_xyz",
      "toolName": "Bash",
      "input": { "command": "ls -la" }
    }
  }
}
```

`kind` can be:
- `scheduled`: tool scheduled
- `started`: tool started executing
- `progress`: progress update (stdoutTail / stderrTail)
- `result`: tool finished
- `error`: tool error
- `batch`: multiple tools finished in a batch

### `turn.completed`

The turn completed.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 46,
    "type": "turn.completed",
    "payload": {
      "resultType": "success",
      "usage": {
        "totalTokens": 1234
      }
    }
  }
}
```

### `turn.failed`

The turn failed.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 47,
    "type": "turn.failed",
    "payload": {
      "error": {
        "code": 1308,
        "message": "prompt is running"
      }
    }
  }
}
```

### `session.updated`

Session state update (usage, etc.).

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 48,
    "type": "session.updated",
    "payload": {
      "usage": {
        "inputTokens": 1234
      },
      "contextWindow": 32000
    }
  }
}
```

## Interaction Protocol (Server -> Client)

Requests that zcode actively sends to the bridge.

### `interaction/requestPermission`

Tool permission request.

```json
{
  "id": 100,
  "method": "interaction/requestPermission",
  "params": {
    "requestId": "req_xyz",
    "sessionId": "sess_abc123",
    "toolCallId": "call_xyz",
    "toolName": "Bash",
    "reason": "run command",
    "input": { "command": "rm -rf /" },
    "options": [
      { "optionId": "allow", "kind": "allow_once", "name": "Allow once" },
      { "optionId": "deny", "kind": "deny_once", "name": "Deny" }
    ]
  }
}
```

### `interaction/requestUserInput`

User input request (ExitPlanMode / AskUserQuestion).

**ExitPlanMode:**
```json
{
  "id": 101,
  "method": "interaction/requestUserInput",
  "params": {
    "requestId": "req_xyz",
    "sessionId": "sess_abc123",
    "toolCallId": "call_xyz",
    "schema": { "interaction": "plan_approval" },
    "input": { "plan": "1. Implement login\n2. Implement signup" }
  }
}
```

**AskUserQuestion:**
```json
{
  "id": 102,
  "method": "interaction/requestUserInput",
  "params": {
    "requestId": "req_xyz",
    "sessionId": "sess_abc123",
    "toolCallId": "call_xyz",
    "questions": [
      {
        "question": "Select the files to test",
        "multiSelect": true,
        "options": [
          { "label": "auth.test.ts", "value": "auth" },
          { "label": "user.test.ts", "value": "user" }
        ]
      }
    ]
  }
}
```

### Bridge routing (protocol negotiation)

ZCode `interaction/*` requests are routed to different ACP interaction
mechanisms based on client capabilities:

| Request type | Client supports elicitation.form | Client does not |
|---------|:------------------------:|:----------:|
| Tool auth (`interaction/requestPermission`) | `session/request_permission` | `session/request_permission` |
| ExitPlanMode (`interaction/requestUserInput` + plan_approval) | `elicitation/create` (approve/reject form) | `session/request_permission` |
| AskUserQuestion (`interaction/requestUserInput`) | `elicitation/create` (single form) | per-question `session/request_permission` |

**Capability detection**: at `initialize` time the client declares support via
`clientCapabilities.elicitation.form`. The server detects it with
`server.supportsElicitationForm()`.

**elicitation form example** (AskUserQuestion):
```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "sessionId": "sess_abc123",
    "message": "Please answer 2 questions.",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "q_0": {
          "type": "string",
          "enum": ["auth.test.ts", "user.test.ts"],
          "title": "Select the files to test"
        }
      },
      "required": ["q_0"]
    }
  }
}
```

**elicitation response** (accept/decline/cancel):
```json
{
  "action": "accept",
  "content": { "q_0": "auth.test.ts" }
}
```

## Extension Methods (0.14.8+)

### `session/fork`

Fork a new session from a checkpoint.

**Request:**
```json
{
  "id": 8,
  "method": "session/fork",
  "params": {
    "sessionId": "sess_abc123",
    "target": { "kind": "latestCheckpoint" }
  }
}
```

### `session/rewind`

Rewind to a checkpoint.

**Request:**
```json
{
  "id": 9,
  "method": "session/rewind",
  "params": {
    "sessionId": "sess_abc123",
    "target": { "kind": "latestCheckpoint" },
    "expectedRevision": 42
  }
}
```

### `session/goal`

Read / set / replace / clear the goal.

**Request:**
```json
{
  "id": 10,
  "method": "session/goal",
  "params": {
    "sessionId": "sess_abc123",
    "action": "set",
    "objective": "Refactor the auth module"
  }
}
```

`action` can be: `show`, `set`, `replace`, `clear`, `pause`, `resume`

### `session/compact`

Compact the conversation history.

**Request:**
```json
{
  "id": 11,
  "method": "session/compact",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

### `session/steer`

Append instructions to a running turn.

**Request:**
```json
{
  "id": 12,
  "method": "session/steer",
  "params": {
    "sessionId": "sess_abc123",
    "content": "Please use TypeScript instead of JavaScript"
  }
}
```

### `session/setMode`

Switch the session mode.

**Request:**
```json
{
  "id": 13,
  "method": "session/setMode",
  "params": {
    "sessionId": "sess_abc123",
    "mode": "build"
  }
}
```

### `session/setThoughtLevel`

Set the thought level.

**Request:**
```json
{
  "id": 14,
  "method": "session/setThoughtLevel",
  "params": {
    "sessionId": "sess_abc123",
    "thoughtLevel": "max"
  }
}
```

## Version Compatibility

| ZCode CLI version | session/subscribe | Extension methods | Notes |
|---------------|-------------------|----------|------|
| >= 0.15.0 | Supported | All supported | Full functionality |
| >= 0.14.8 | Supported | Partially supported | workspace/* unavailable |
| 0.14.5 ~ 0.14.7 | Not supported | Not supported | Incompatible with this project |
