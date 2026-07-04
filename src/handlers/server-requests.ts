/**
 * Handle zcode-initiated server→client requests during a turn.
 *
 * ZCode's interaction broker dispatches three request kinds, all bridged onto
 * ACP `session/requestPermission` (Zed supports it natively; elicitation is
 * not supported):
 *   - interaction/requestPermission (tool auth)       → direct option mapping
 *   - interaction/requestUserInput (ExitPlanMode)     → approve/reject options
 *   - interaction/requestUserInput (AskUserQuestion)  → per-question popups
 *     (single-select: one popup; multi-select: per-option Include/Skip)
 *
 * Reannounce dedup: ZCode reannounces unanswered requests every ~1s sharing
 * the same requestId/toolCallId. The first request forwards to the client;
 * reannounces either get the cached result (if it arrived) or just record
 * their zcode id for a later unified reply.
 */

import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";

import type { ServerRequest, ZcodeBackend } from "../backend/client.js";
import type {
  ZcodeInteractionPermissionParams,
  ZcodeInteractionResponse,
  ZcodeInteractionUserInputParams,
} from "../backend/types.js";
import {
  acpPermissionResponseToExitPlanMode,
  acpPermissionResponseToZcode,
  buildAskUserAcpParams,
  exitPlanModeToAcpPermission,
  isAskUserQuestion,
  isExitPlanMode,
  isPermissionRequest,
  parseAskUserResponse,
  splitAskUserQuestions,
  zcodePermissionToAcp,
} from "../interaction/adapter.js";
import { log } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { sendSessionUpdate } from "./io.js";

/** A dedup entry tracking reannounced zcode ids + the cached result. */
interface DedupEntry {
  zcodeIds: number[];
  result?: ZcodeInteractionResponse;
}

/** Per-server reannounce dedup state (lazy-initialised). */
export function getPendingInteractions(server: ZcodeAcpServer): Map<string, DedupEntry> {
  const existing = (server as unknown as { _pendingInteractions?: Map<string, DedupEntry> })
    ._pendingInteractions;
  if (existing) return existing;
  const fresh = new Map<string, DedupEntry>();
  (server as unknown as { _pendingInteractions: Map<string, DedupEntry> })._pendingInteractions =
    fresh;
  return fresh;
}

/**
 * Drain and handle all pending zcode server→client requests. Returns true if
 * any were handled (used by the turn loop to refresh the no-progress timer).
 */
export async function handleServerRequests(
  server: ZcodeAcpServer,
  backend: ZcodeBackend,
  cx: acp.AgentContext,
  acpSid: string,
): Promise<boolean> {
  const pending = getPendingInteractions(server);
  let handled = false;

  for (;;) {
    const req = backend.pollServerRequests().shift() ?? null;
    if (!req) return handled;
    handled = true;
    await handleOne(server, backend, cx, acpSid, req, pending);
  }
}

async function handleOne(
  server: ZcodeAcpServer,
  backend: ZcodeBackend,
  cx: acp.AgentContext,
  acpSid: string,
  req: ServerRequest,
  pending: Map<string, DedupEntry>,
): Promise<void> {
  const method = req.method;
  const zcodeReqId = req.id;
  const params = req.params as
    ZcodeInteractionPermissionParams | ZcodeInteractionUserInputParams | Record<string, unknown>;

  const ask = isAskUserQuestion(method, params);
  const perm = isPermissionRequest(method);
  const epm = isExitPlanMode(params);

  if (!perm && !(isUserInputRequestUnchecked(method) && (epm || ask))) {
    log(`  ⚠ unhandled server→client request: ${method} (id=${zcodeReqId})`);
    sendZcodeError(backend, zcodeReqId, `bridge unsupported: ${method}`);
    return;
  }

  // Reannounce dedup.
  const dedupKey =
    (params as { requestId?: string; toolCallId?: string }).requestId ??
    (params as { toolCallId?: string }).toolCallId ??
    null;
  if (dedupKey && pending.has(dedupKey)) {
    const entry = pending.get(dedupKey)!;
    if (entry.result !== undefined) {
      // Result already cached (client responded earlier): reply directly with
      // {id, result} so zcode resolves the reannounced request. Must NOT use
      // notify() (that writes {method, params}, not a valid response).
      backend.sendReply(zcodeReqId, entry.result);
      log(`  ⟳ reannounce, returning cached result (zcode_id=${zcodeReqId})`);
    } else {
      entry.zcodeIds.push(zcodeReqId);
      log(`  ⟳ reannounce, recording zcode_id=${zcodeReqId} (no re-prompt)`);
    }
    return;
  }
  if (dedupKey) pending.set(dedupKey, { zcodeIds: [zcodeReqId] });

  let zcodeResp: ZcodeInteractionResponse;
  if (ask) {
    zcodeResp = await handleAskUserQuestion(
      server,
      cx,
      acpSid,
      params as ZcodeInteractionUserInputParams,
    );
  } else {
    zcodeResp = await handleSinglePermission(server, cx, acpSid, params, epm, perm);
  }

  // Reply to the first zcode id + all reannounced ones, and cache for late reannounces.
  sendInteractionReply(backend, pending, dedupKey, zcodeReqId, zcodeResp);
}

/** Single requestPermission (tool auth / ExitPlanMode). */
async function handleSinglePermission(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  params:
    ZcodeInteractionPermissionParams | ZcodeInteractionUserInputParams | Record<string, unknown>,
  epm: boolean,
  perm: boolean,
): Promise<ZcodeInteractionResponse> {
  const p = params as ZcodeInteractionPermissionParams & ZcodeInteractionUserInputParams;
  // Emit a tool_call first so Zed renders the popup (it requires the toolCallId
  // to have been emitted before request_permission).
  const toolCallId = p.toolCallId ?? "";
  const rawInput = p.input;
  const tcTitle = epm
    ? "Ready to code?"
    : perm
      ? `tool permission (${p.toolName ?? "?"})`
      : "interaction";
  const tcKind = epm ? "switch_mode" : "other";
  const toolName = epm ? "ExitPlanMode" : (p.toolName ?? "");
  const tcUpdate: acp.SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId,
    title: tcTitle,
    kind: tcKind,
    status: "pending",
    rawInput,
    _meta: { claudeCode: { toolName } },
  };
  if (epm && rawInput && typeof rawInput === "object") {
    const planText = (rawInput as { plan?: string }).plan;
    if (planText) {
      tcUpdate.content = [{ type: "content", content: { type: "text", text: planText } }];
    }
  }
  await sendSessionUpdate(cx, acpSid, tcUpdate);

  const acpParams = perm
    ? zcodePermissionToAcp(p as ZcodeInteractionPermissionParams, acpSid)!
    : exitPlanModeToAcpPermission(p as ZcodeInteractionUserInputParams, acpSid);

  const acpReqId = server.nextId();
  log(
    `  ⟳ ${toolName || "permission"}, forwarding session/request_permission (acp_id=${acpReqId})`,
  );
  const acpResp = await cx
    .request("session/request_permission", acpParams, { cancellationSignal: undefined as never })
    .catch((e: unknown) => {
      log(`  ⚠ request_permission failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
  if (acpResp === null) {
    return { action: "decline", reason: "timeout or cancelled" };
  }
  return perm
    ? acpPermissionResponseToZcode(acpResp)
    : acpPermissionResponseToExitPlanMode(acpResp);
}

/**
 * AskUserQuestion: sequential per-question, multi-select per-option.
 *
 * Single-select: one popup per question; Skip/cancel/timeout → overall decline.
 * Multi-select: one Include/Skip popup per option; Include picks comma-joined.
 */
async function handleAskUserQuestion(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  params: ZcodeInteractionUserInputParams,
): Promise<ZcodeInteractionResponse> {
  const qs = splitAskUserQuestions(params);
  if (qs === null) {
    log("  ⚠ AskUserQuestion: no valid questions, declining");
    return { action: "decline", reason: "no valid questions" };
  }
  const toolCallId = params.toolCallId ?? "";
  const rawInput = params.input;
  const answers: Record<string, string> = {};

  for (let idx = 0; idx < qs.length; idx++) {
    const q = qs[idx]!;
    if (!q.multiSelect) {
      // Single-select: one popup.
      await emitAskToolCall(cx, acpSid, toolCallId, idx, q.question, rawInput);
      const acpParams = buildAskUserAcpParams(params, acpSid, q.options);
      acpParams.toolCall.toolCallId = `${toolCallId}_${idx}`;
      const resp = await askOnce(server, cx, acpParams, idx + 1, qs.length, q.question);
      const selected = parseAskUserResponse(resp);
      if (selected === null) {
        log(`  ⚠ AskUserQuestion [${idx + 1}] skip/cancel/timeout, declining`);
        return { action: "decline", reason: "skipped or cancelled" };
      }
      answers[q.question] = selected;
      log(`  ✓ AskUserQuestion [${idx + 1}] answer: ${selected}`);
    } else {
      // Multi-select: per-option yes/no. options is [opt0_yes, opt0_no, opt1_yes, opt1_no, ...].
      const pairs: Array<{ label: string; pair: typeof q.options }> = [];
      for (let i = 0; i < q.options.length; i += 2) {
        const yesOpt = q.options[i];
        const noOpt = q.options[i + 1];
        if (!yesOpt || !noOpt) continue;
        pairs.push({ label: yesOpt.optionId.replace(/:yes$/, ""), pair: [yesOpt, noOpt] });
      }
      const picked: string[] = [];
      for (let sub = 0; sub < pairs.length; sub++) {
        const { label, pair } = pairs[sub]!;
        const promptText = `${q.question}\n— include "${label}"?`;
        await emitAskToolCall(cx, acpSid, toolCallId, `${idx}_${sub}`, promptText, rawInput);
        const acpParams = buildAskUserAcpParams(params, acpSid, pair);
        acpParams.toolCall.toolCallId = `${toolCallId}_${idx}_${sub}`;
        const resp = await askOnce(server, cx, acpParams, idx + 1, qs.length, label);
        if (parseAskUserResponse(resp) === "yes") {
          picked.push(label);
          log(`  ✓ AskUserQuestion [${idx + 1}] multi picked: ${label}`);
        } else {
          log(`  · AskUserQuestion [${idx + 1}] multi skipped: ${label}`);
        }
      }
      answers[q.question] = picked.join(", ");
      log(`  ✓ AskUserQuestion [${idx + 1}] multi answer: ${answers[q.question] || "(none)"}`);
    }
  }
  log(`  ✓ AskUserQuestion all answered (${Object.keys(answers).length}), replying`);
  return { action: "accept", content: { answers } };
}

/** Emit the prerequisite tool_call for an AskUserQuestion popup. */
async function emitAskToolCall(
  cx: acp.AgentContext,
  acpSid: string,
  toolCallId: string,
  idxSuffix: number | string,
  qText: string,
  rawInput: unknown,
): Promise<void> {
  await sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "tool_call",
    toolCallId: `${toolCallId}_${idxSuffix}`,
    title: qText,
    kind: "other",
    status: "pending",
    rawInput,
    _meta: { claudeCode: { toolName: "AskUserQuestion" } },
    content: [{ type: "content", content: { type: "text", text: qText } }],
  });
}

/** Send one requestPermission and await the response. */
async function askOnce(
  _server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpParams: {
    options: unknown[];
    sessionId: string;
    toolCall: { toolCallId: string; rawInput: unknown };
  },
  _qNum: number,
  _qTotal: number,
  _label: string,
): Promise<unknown> {
  const acpReqId = _server.nextId();
  log(`  ⟳ AskUserQuestion forwarding session/request_permission (acp_id=${acpReqId})`);
  return cx
    .request("session/request_permission", acpParams as never, {
      cancellationSignal: undefined as never,
    })
    .catch((e: unknown) => {
      log(`  ⚠ request_permission failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
}

// ---------- reply helpers ----------

/** Reply to the first zcode id + all reannounced ones, cache for late reannounces. */
function sendInteractionReply(
  backend: ZcodeBackend,
  pending: Map<string, DedupEntry>,
  dedupKey: string | null,
  firstZcodeId: number,
  result: ZcodeInteractionResponse,
): void {
  const ids = dedupKey && pending.has(dedupKey) ? pending.get(dedupKey)!.zcodeIds : [firstZcodeId];
  if (dedupKey && pending.has(dedupKey)) {
    pending.get(dedupKey)!.result = result;
  }
  for (const id of ids) {
    sendZcodeReply(backend, id, result);
  }
  log(`  ✓ replied to zcode (${ids.length} request(s))`);
  // Schedule cleanup so late reannounces (after the result) still hit the cache briefly.
  if (dedupKey) {
    setTimeout(() => pending.delete(dedupKey), 30_000).unref();
  }
}

/** Send a zcode response (result) for a server→client request id. */
function sendZcodeReply(
  backend: ZcodeBackend,
  zcodeId: number,
  result: ZcodeInteractionResponse,
): void {
  // zcode expects {id, result} — but our backend.notify sends {method, params}. Use a raw write.
  // The backend's notify is for notifications; replies need the id. We route via a private seam.
  (backend as unknown as { sendReply: (id: number, result: unknown) => void }).sendReply(
    zcodeId,
    result,
  );
}

/** Send a zcode error response. */
function sendZcodeError(backend: ZcodeBackend, zcodeId: number, message: string): void {
  (
    backend as unknown as { sendError: (id: number, code: number, message: string) => void }
  ).sendError(zcodeId, -32601, message);
}

function isUserInputRequestUnchecked(method: string): boolean {
  return method === "interaction/requestUserInput";
}

// Unused export guard to keep randomUUID import if not otherwise referenced.
void randomUUID;
