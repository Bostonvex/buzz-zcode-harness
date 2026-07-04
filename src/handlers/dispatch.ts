/**
 * dispatchEvent — the single funnel that turns an InternalEvent into an ACP
 * `session/update` notification.
 *
 * Each event kind is serialised here so the translation layers stay focused
 * on producing the internal shape. The Bash terminal-output protocol (the
 * 2-notification split: terminal_output + terminal_exit) lands in Commit 5;
 * for now the terminal path is wired but emits the standard single update so
 * the server is end-to-end functional.
 */

import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";

import { extractExitCode, TOOL_KIND_MAP } from "../translators/tool-helpers.js";
import type { InternalEvent } from "../translators/types.js";
import type { ZcodeAcpServer } from "../server.js";
import { sendSessionUpdate } from "./io.js";

/** Dispatch one internal event to the ACP client as a session/update. */
export async function dispatchEvent(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: InternalEvent,
  chunkMsgId: string,
): Promise<void> {
  switch (ev.kind) {
    case "ToolCallNew":
      await dispatchToolCallNew(server, cx, acpSid, ev);
      break;
    case "ToolCallUpdate":
      await dispatchToolCallUpdate(server, cx, acpSid, ev);
      break;
    case "UsageDelta":
      await dispatchUsageDelta(server, cx, acpSid, ev);
      break;
    case "TextDelta":
      await sendSessionUpdate(cx, acpSid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: ev.text },
        messageId: chunkMsgId,
      });
      break;
    case "ReasoningDelta":
      await sendSessionUpdate(cx, acpSid, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: ev.text },
        messageId: `thought_${chunkMsgId}`,
      });
      break;
    case "PlanUpdate":
      await sendSessionUpdate(cx, acpSid, {
        sessionUpdate: "plan",
        entries: ev.entries,
      });
      break;
    case "FilesChanged":
      await dispatchFilesChanged(cx, acpSid, ev);
      break;
  }
}

function dispatchToolCallNew(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "ToolCallNew" }>,
): Promise<void> {
  const termSupported =
    server.supportsTerminalOutput() && (ev.tool === "Bash" || ev.tool === "bash");
  const meta: Record<string, unknown> = { claudeCode: { toolName: ev.tool } };
  if (termSupported) meta["terminal_info"] = { terminal_id: ev.callId };

  const update: acp.SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: ev.callId,
    title: ev.title,
    kind: (TOOL_KIND_MAP[ev.tool] ?? "other") as acp.ToolKind,
    status: ev.status,
    rawInput: ev.input,
    _meta: meta,
  };
  if (termSupported) {
    update.content = [{ type: "terminal", terminalId: ev.callId }];
  } else if (ev.diffContent && ev.diffContent.length > 0) {
    update.content = ev.diffContent;
  } else if (ev.content && ev.content.length > 0) {
    update.content = ev.content;
  }
  if (ev.locations && ev.locations.length > 0) update.locations = ev.locations;
  return sendSessionUpdate(cx, acpSid, update);
}

function dispatchToolCallUpdate(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "ToolCallUpdate" }>,
): Promise<void> {
  const toolName = ev.tool ?? "";
  const termSupported =
    server.supportsTerminalOutput() && (toolName === "Bash" || toolName === "bash");

  if (termSupported) {
    // Bash terminal protocol (full 2-notification split arrives in Commit 5).
    // For now emit the terminal_output data + the standard update with status.
    return dispatchTerminalUpdate(server, cx, acpSid, ev, toolName);
  }

  const update: acp.SessionUpdate = {
    sessionUpdate: "tool_call_update",
    toolCallId: ev.callId,
    status: ev.status,
  };
  const meta: Record<string, unknown> = {};
  if (toolName) meta["claudeCode"] = { toolName };
  if (ev.output !== undefined) update.rawOutput = ev.output;
  if (ev.diffContent && ev.diffContent.length > 0) {
    update.content = ev.diffContent;
  } else if (ev.content && ev.content.length > 0) {
    update.content = ev.content;
  }
  if (Object.keys(meta).length > 0) update._meta = meta;
  if (ev.locations && ev.locations.length > 0) update.locations = ev.locations;
  return sendSessionUpdate(cx, acpSid, update);
}

/**
 * Bash terminal update (interim): emit the data + status in the standard
 * single update. Commit 5 replaces this with the 2-notification split.
 */
function dispatchTerminalUpdate(
  _server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "ToolCallUpdate" }>,
  toolName: string,
): Promise<void> {
  let termData: unknown = ev.rawOutput ?? ev.rawResult;
  if (termData && typeof termData === "object" && !Array.isArray(termData)) {
    termData = (termData as Record<string, unknown>)["content"] ?? "";
  }
  const update: acp.SessionUpdate = {
    sessionUpdate: "tool_call_update",
    toolCallId: ev.callId,
    status: ev.status,
  };
  const meta: Record<string, unknown> = { claudeCode: { toolName } };
  if (ev.status === "completed" || ev.status === "failed") {
    meta["terminal_exit"] = {
      terminal_id: ev.callId,
      exit_code: extractExitCode(ev.rawResult, ev.status === "failed"),
      signal: null,
    };
    update.content = [{ type: "terminal", terminalId: ev.callId }];
  } else if (termData) {
    meta["terminal_output"] = { terminal_id: ev.callId, data: String(termData) };
  }
  if (ev.output !== undefined) update.rawOutput = ev.output;
  update._meta = meta;
  return sendSessionUpdate(cx, acpSid, update);
}

async function dispatchUsageDelta(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "UsageDelta" }>,
): Promise<void> {
  // The backend often returns contextWindow=0; fill from the model's config
  // limit.context (Commit 7 wires _modelContextWindow). For now pass through.
  let size = ev.size;
  if (!size) {
    size = await modelContextWindowStub(server, acpSid);
  }
  await sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "usage_update",
    used: ev.used,
    size,
  });
}

/** Placeholder for the config-backed context window (filled in Commit 7). */
async function modelContextWindowStub(_server: ZcodeAcpServer, _acpSid: string): Promise<number> {
  return 0;
}

function dispatchFilesChanged(
  cx: acp.AgentContext,
  acpSid: string,
  ev: Extract<InternalEvent, { kind: "FilesChanged" }>,
): Promise<void> {
  const files = ev.files;
  const preview = files.slice(0, 3).join(", ");
  const ellipsis = files.length > 3 ? "..." : "";
  return sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "tool_call",
    toolCallId: `files_${randomUUID().slice(0, 8)}`,
    title: `changed files (${files.length}): ${preview}${ellipsis}`,
    kind: "edit",
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "affected files:\n" + files.join("\n") } },
    ],
  });
}
