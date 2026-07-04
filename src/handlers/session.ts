/**
 * Session lifecycle handlers: initialize, new, list, resume, load, prompt, cancel.
 *
 * These map ACP session methods to ZCode app-server calls. `session/prompt` runs
 * the event-driven turn loop (subscribe-before-send ordering, no-progress
 * timeout, stall reconciliation) — text/tool translation is wired in Commit 4
 * and the Bash terminal protocol in Commit 5; for now this loop forwards
 * streaming text and waits for turn completion so the path is end-to-end
 * usable.
 */

import process from "node:process";
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

import { EventStreamListener, TurnMonitor } from "../backend/listener.js";
import type {
  ZcodeCreateResult,
  ZcodeListResult,
  ZcodeMessage,
  ZcodeMessagesResult,
} from "../backend/types.js";
import { log } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { sendSessionUpdate, sendTextChunk } from "./io.js";

/** Workspace descriptor used in session create/resume calls. */
function workspaceFor(cwd?: string): { workspacePath: string; workspaceKey: string } {
  const p = cwd || process.cwd();
  return { workspacePath: p, workspaceKey: p };
}

/** Convert a millisecond timestamp to ISO 8601 (for session list). */
function toIso(ms: number | undefined): string | undefined {
  if (typeof ms !== "number") return undefined;
  return new Date(ms).toISOString();
}

/** `session/new` → zcode `session/create` (mode hardcoded yolo). */
export async function newSession(
  server: ZcodeAcpServer,
  params: acp.NewSessionRequest,
): Promise<acp.NewSessionResponse> {
  const backend = server.ensureBackend();
  const cwd = params.cwd ?? process.cwd();
  log(`session/new: cwd=${cwd}`);

  const resp = await backend.request(
    server.nextId(),
    "session/create",
    { workspace: workspaceFor(cwd), mode: "yolo" },
    15000,
  );
  if (resp.error) {
    throw new Error(`zcode create failed: ${resp.error.message ?? ""}`);
  }
  const result = (resp.result ?? {}) as ZcodeCreateResult;
  const session = result.session ?? {};
  const sid = session.sessionId;
  if (!sid) throw new Error("zcode create returned no sessionId");

  server.sessionMap.set(sid, sid);
  log(`session/new → ${sid}`);

  // Commit 7 fills modes/configOptions; return minimal valid response for now.
  void sendAvailableCommandsDeferred(server, sid);
  return { sessionId: sid };
}

/** `session/list` → zcode `session/list`. */
export async function listSessions(
  server: ZcodeAcpServer,
  params: acp.ListSessionsRequest,
): Promise<acp.ListSessionsResponse> {
  const backend = server.ensureBackend();
  const zcParams: Record<string, unknown> = {};
  if (params.cwd) {
    zcParams.workspace = workspaceFor(params.cwd);
  }

  const resp = await backend.request(server.nextId(), "session/list", zcParams, 15000);
  if (resp.error) throw new Error(`zcode list failed: ${resp.error.message ?? ""}`);

  const result = (resp.result ?? {}) as ZcodeListResult;
  const sessions = (result.sessions ?? []).map((s) => ({
    sessionId: s.sessionId ?? "",
    cwd: s.workspace?.workspacePath ?? "",
    title: s.title,
    updatedAt: toIso(s.updatedAt),
  }));
  log(`session/list → ${sessions.length} sessions`);
  return { sessions };
}

/** `session/resume` → zcode `session/resume` (+ runtimeModel overlay in Commit 7). */
export async function resumeSession(
  server: ZcodeAcpServer,
  params: acp.ResumeSessionRequest,
): Promise<acp.ResumeSessionResponse> {
  const backend = server.ensureBackend();
  const targetSid = params.sessionId;
  const cwd = params.cwd ?? process.cwd();
  if (!targetSid) throw new Error("sessionId required");

  const zcParams: Record<string, unknown> = {
    sessionId: targetSid,
    workspace: workspaceFor(cwd),
  };
  // runtimeModel overlay added in Commit 7.
  const resp = await backend.request(server.nextId(), "session/resume", zcParams, 15000);
  if (resp.error) throw new Error(`zcode resume failed: ${resp.error.message ?? ""}`);

  server.sessionMap.set(targetSid, targetSid);
  log(`session/resume → ${targetSid}`);
  void sendAvailableCommandsDeferred(server, targetSid);
  return {};
}

/**
 * `session/load` → zcode `session/resume` + stream conversation history back as
 * `session/update` notifications (text/reasoning/简化 tool_call).
 */
export async function loadSession(
  server: ZcodeAcpServer,
  params: acp.LoadSessionRequest,
  cx: acp.AgentContext,
): Promise<acp.LoadSessionResponse> {
  const backend = server.ensureBackend();
  const targetSid = params.sessionId;
  const cwd = params.cwd ?? process.cwd();
  if (!targetSid) throw new Error("sessionId required");

  const zcParams: Record<string, unknown> = {
    sessionId: targetSid,
    workspace: workspaceFor(cwd),
  };
  const resp = await backend.request(server.nextId(), "session/resume", zcParams, 15000);
  if (resp.error) throw new Error(`zcode resume failed: ${resp.error.message ?? ""}`);
  server.sessionMap.set(targetSid, targetSid);
  log(`session/load → ${targetSid}`);

  const messages = await fetchMessages(server, targetSid);
  let replayed = 0;
  for (const m of messages) {
    const info = m.info ?? {};
    const role = info.role;
    const mid = info.id ?? `hist_${randomUUID().slice(0, 12)}`;
    for (const p of m.parts ?? []) {
      if (!p || typeof p !== "object") continue;
      const ptype = (p as { type?: string }).type;
      if (ptype === "text") {
        const text = (p as { text?: string }).text ?? "";
        if (!text) continue;
        const sessionUpdate = role === "user" ? "user_message_chunk" : "agent_message_chunk";
        await sendSessionUpdate(cx, targetSid, {
          sessionUpdate,
          content: { type: "text", text },
          messageId: mid,
        });
      } else if (ptype === "reasoning") {
        const rp = p as { text?: string; content?: string };
        const text = rp.text ?? rp.content ?? "";
        if (text) {
          await sendSessionUpdate(cx, targetSid, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text },
            messageId: `thought_${mid}`,
          });
        }
      } else if (ptype === "tool") {
        const tp = p as {
          id?: string;
          tool?: string;
          title?: string;
          status?: string;
        };
        const title = tp.title ?? tp.tool ?? "tool call";
        const histToolName = tp.tool ?? "";
        const update: acp.SessionUpdate = {
          sessionUpdate: "tool_call",
          toolCallId: tp.id ?? `histtool_${randomUUID().slice(0, 8)}`,
          title,
          kind: "other",
          status: (tp.status as acp.ToolCallStatus) ?? "completed",
          ...(histToolName ? { _meta: { claudeCode: { toolName: histToolName } } } : {}),
        };
        await sendSessionUpdate(cx, targetSid, update);
      }
      // patch / step-start / other: skipped (history replay focuses on text + tool summary)
    }
    replayed += 1;
  }
  log(`session/load: replayed ${replayed} messages`);

  // Initial plan replay + emit_initial_usage arrive in Commits 4/7.
  void sendAvailableCommandsDeferred(server, targetSid);
  return {};
}

/** `session/prompt` → subscribe-before-send, run the event-driven turn loop. */
export async function prompt(
  server: ZcodeAcpServer,
  params: acp.PromptRequest,
  cx: acp.AgentContext,
  requestId: number,
): Promise<acp.PromptResponse> {
  const backend = server.ensureBackend();
  const zcodeSid = server.resolveSid(params.sessionId);
  if (!zcodeSid) throw new Error(`session ${params.sessionId} not found`);

  // Extract prompt text from ACP ContentBlock[].
  const text = extractPromptText(params.prompt);
  if (!text) throw new Error("empty prompt");

  // Register the pending turn.
  const turn: { zcodeSid: string; cancelled: boolean } = { zcodeSid, cancelled: false };
  server.pendingTurns.set(requestId, {
    zcodeSid,
    cancelled: false,
    permResponses: new Map(),
  });

  const listener = new EventStreamListener(backend, zcodeSid);
  const monitor = new TurnMonitor(backend, zcodeSid, () => server.nextId());

  // Subscribe BEFORE send so we don't lose early turn.completed on short turns.
  const snapshot = await listener.subscribe(() => server.nextId());
  if (snapshot === null) {
    server.pendingTurns.delete(requestId);
    throw new Error("session/subscribe failed (ZCode CLI 0.14.8+ required)");
  }
  backend.registerEventListener(zcodeSid, listener);

  const chunkMsgId = randomUUID();
  try {
    const sendResp = await backend.request(
      server.nextId(),
      "session/send",
      { sessionId: zcodeSid, content: text },
      15000,
    );
    if (sendResp.error) throw new Error(`zcode send failed: ${sendResp.error.message ?? ""}`);
    const accepted = (sendResp.result ?? {}) as { accepted?: boolean };
    if (!accepted.accepted) throw new Error("zcode send not accepted");

    // Minimal turn loop: forward streaming text, wait for turn completion.
    // Full translation (tool_call, usage, plan, terminal) lands in Commit 4/5.
    const result = await runEventTurnMinimal(
      server,
      listener,
      monitor,
      cx,
      params.sessionId,
      chunkMsgId,
      turn,
    );
    return result;
  } finally {
    backend.unregisterEventListener(zcodeSid);
    server.pendingTurns.delete(requestId);
  }
}

/** `session/cancel` → mark the pending turn cancelled + forward session/stop. */
export async function cancel(
  server: ZcodeAcpServer,
  params: acp.CancelNotification,
): Promise<void> {
  const zcodeSid = server.resolveSid(params.sessionId);
  if (!zcodeSid) return;
  for (const [, turn] of server.pendingTurns) {
    if (turn.zcodeSid === zcodeSid) turn.cancelled = true;
  }
  server.ensureBackend().notify("session/stop", { sessionId: zcodeSid });
  log(`session/cancel → ${zcodeSid}`);
}

// ---------- internals ----------

/** Concatenate text from ACP ContentBlocks into a prompt string. */
function extractPromptText(blocks: acp.ContentBlock[] | undefined): string {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    const b = block as {
      type?: string;
      text?: string;
      resource_link?: { name?: string; uri?: string };
    };
    if (b.type === "text" && b.text) {
      parts.push(b.text);
    } else if (b.type === "resource_link" && b.resource_link) {
      parts.push(
        `[related resource: ${b.resource_link.name ?? b.resource_link.uri ?? ""}](${b.resource_link.uri ?? ""})`,
      );
    }
  }
  return parts.join("\n").trim();
}

/** Fetch session/messages from zcode. */
async function fetchMessages(server: ZcodeAcpServer, zcodeSid: string): Promise<ZcodeMessage[]> {
  const backend = server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "session/messages",
    { sessionId: zcodeSid },
    8000,
  );
  if (resp.error) return [];
  const result = (resp.result ?? {}) as ZcodeMessagesResult;
  return result.messages ?? [];
}

/**
 * Minimal event-driven turn loop (replaced by the full translator in Commit 4).
 *
 * Forwards `model.streaming` text deltas to the client and waits for
 * turn.completed/turn.failed. No-progress timeout is 120s (refreshed by any
 * event). Cancel is honoured on each iteration.
 */
async function runEventTurnMinimal(
  server: ZcodeAcpServer,
  listener: EventStreamListener,
  monitor: TurnMonitor,
  cx: acp.AgentContext,
  acpSid: string,
  chunkMsgId: string,
  turn: { zcodeSid: string; cancelled: boolean },
): Promise<acp.PromptResponse> {
  const backend = server.ensureBackend();
  const NO_PROGRESS_MS = 120_000;
  let lastProgress = Date.now();
  let turnStarted = false;

  while (Date.now() - lastProgress < NO_PROGRESS_MS) {
    // Drain server→client requests during the turn (full handling in Commit 6).
    backend.pollServerRequests();

    if (turn.cancelled) {
      backend.notify("session/stop", { sessionId: turn.zcodeSid });
      return { stopReason: "cancelled" };
    }

    const ev = await listener.pollEvent(500);
    if (ev === null) {
      // Stall reconciliation: probe authoritative status.
      if (turnStarted && Date.now() - lastProgress > 15_000) {
        const proj = await monitor.pollOnce();
        if (proj?.status === "idle") {
          return { stopReason: "end_turn" };
        }
        if (proj?.status === "running") {
          lastProgress = Date.now();
          await listener.resubscribe(() => server.nextId());
        }
      }
      continue;
    }

    lastProgress = Date.now();
    if (ev.type === "turn.started") {
      turnStarted = true;
      continue;
    }
    if (ev.type === "turn.completed") {
      const payload = ev.payload as { resultType?: string };
      if (payload.resultType === "cancelled") return { stopReason: "cancelled" };
      return { stopReason: "end_turn" };
    }
    if (ev.type === "turn.failed") {
      const payload = ev.payload as { error?: { message?: string; code?: string } };
      throw new RequestError(-32603, formatTurnError(payload.error));
    }
    if (ev.type === "model.streaming") {
      const payload = ev.payload as { kind?: string; delta?: string };
      if (payload.kind === "text_delta" && payload.delta) {
        await sendTextChunk(cx, acpSid, payload.delta, chunkMsgId);
      }
    }
    // tool.updated / session.updated handled in Commit 4.
  }

  // 120s no progress: abandon.
  backend.notify("session/stop", { sessionId: turn.zcodeSid });
  return { stopReason: "max_turn_requests" };
}

/** Render a turn.failed error into a short message. */
function formatTurnError(err: { message?: string; code?: string } | undefined): string {
  if (!err) return "turn failed";
  const code = err.code ?? "";
  const msg = err.message ?? "";
  return [code, msg].filter(Boolean).join(" ").trim() || "turn failed";
}

/** Send available commands after the response (Commit 8 fills slash handling). */
function sendAvailableCommandsDeferred(_server: ZcodeAcpServer, _acpSid: string): Promise<void> {
  // Stub: the real deferred send (after the response is written) needs the
  // response/id coordination added when index.ts wires the full handler set.
  return Promise.resolve();
}
