/**
 * Interaction channel adapter: zcode `interaction/*` server→client requests
 * ↔ ACP `session/requestPermission`.
 *
 * ZCode's `createProtocolInteractionBroker` dispatches server→client requests
 * by tool. Zed supports `session/requestPermission` natively (the allow/reject
 * popup) but NOT elicitation, so all three interaction kinds map onto
 * requestPermission:
 *   - interaction/requestPermission (tool approval)         → direct mapping
 *   - interaction/requestUserInput (plan_approval / ExitPlanMode) → approve/reject
 *   - interaction/requestUserInput (AskUserQuestion)        → per-question options
 *     (single-select: one popup + Skip; multi-select: per-option Include/Skip)
 *
 * `requestPermission` is single-select, so multi-select questions are split
 * into per-option yes/no popups; the user's Include picks are comma-joined
 * into the final answer (mirrors the reference impl's `answers[q]: "a, b"`).
 */

import type { PermissionOption } from "@agentclientprotocol/sdk";

import type {
  ZcodeInteractionPermissionParams,
  ZcodeInteractionResponse,
  ZcodeInteractionUserInputParams,
} from "../backend/types.js";

// ---------- classification ----------

export function isPermissionRequest(method: string): boolean {
  return method === "interaction/requestPermission";
}

export function isUserInputRequest(method: string): boolean {
  return method === "interaction/requestUserInput";
}

export function isExitPlanMode(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const schema = (params as { schema?: unknown }).schema;
  if (!schema || typeof schema !== "object") return false;
  return (schema as { interaction?: string }).interaction === "plan_approval";
}

/** AskUserQuestion = requestUserInput WITHOUT the plan_approval schema. */
export function isAskUserQuestion(method: string, params: unknown): boolean {
  return isUserInputRequest(method) && !isExitPlanMode(params);
}

// ---------- zcode permission → ACP requestPermission ----------

/** Convert a zcode tool-permission request into ACP requestPermission params. */
export function zcodePermissionToAcp(
  params: ZcodeInteractionPermissionParams,
  acpSid: string,
): {
  options: PermissionOption[];
  sessionId: string;
  toolCall: { toolCallId: string; rawInput: unknown };
} | null {
  const options: PermissionOption[] = [];
  for (const opt of params.options ?? []) {
    options.push({
      optionId: opt.optionId ?? "",
      kind: (opt.kind as PermissionOption["kind"]) ?? "allow_once",
      name: opt.name ?? opt.optionId ?? "",
    });
  }
  if (options.length === 0) return null;
  return {
    options,
    sessionId: acpSid,
    toolCall: { toolCallId: params.toolCallId ?? "", rawInput: params.input },
  };
}

/** Convert an ACP requestPermission response → zcode {decision, reason?}. */
export function acpPermissionResponseToZcode(
  acpResp: unknown,
): Extract<ZcodeInteractionResponse, { decision: string }> {
  if (!acpResp || typeof acpResp !== "object") {
    return { decision: "deny", reason: "invalid client response" };
  }
  const outcome = (acpResp as { outcome?: { outcome?: string; optionId?: string } }).outcome ?? {};
  if (outcome.outcome === "cancelled") return { decision: "deny", reason: "cancelled by user" };
  const optionId = outcome.optionId ?? "";
  if (optionId === "allow" || optionId === "allow_always") return { decision: "allow" };
  return { decision: "deny", reason: `rejected (${optionId})` };
}

// ---------- ExitPlanMode → ACP requestPermission ----------

/** ExitPlanMode rendered as approve/reject permission options. */
export function exitPlanModeToAcpPermission(
  params: ZcodeInteractionUserInputParams,
  acpSid: string,
): {
  options: PermissionOption[];
  sessionId: string;
  toolCall: { toolCallId: string; rawInput: unknown };
} {
  return {
    options: [
      { kind: "allow_once", name: "Approve — exit plan mode", optionId: "approve" },
      { kind: "reject_once", name: "Reject — keep planning", optionId: "reject" },
    ],
    sessionId: acpSid,
    toolCall: { toolCallId: params.toolCallId ?? "", rawInput: params.input },
  };
}

/** Convert an ACP response → zcode ExitPlanMode response. */
export function acpPermissionResponseToExitPlanMode(
  acpResp: unknown,
): Extract<ZcodeInteractionResponse, { action: string }> {
  if (!acpResp || typeof acpResp !== "object") {
    return { action: "decline", reason: "invalid client response" };
  }
  const outcome = (acpResp as { outcome?: { outcome?: string; optionId?: string } }).outcome ?? {};
  if (outcome.outcome === "cancelled") return { action: "decline", reason: "cancelled" };
  if (outcome.optionId === "approve") {
    // content must be an object with answer_0 (zcode reads content.answer_0).
    return { action: "accept", content: { answer_0: "approve" } };
  }
  return { action: "decline", reason: "rejected" };
}

// ---------- AskUserQuestion split (single + multi-select) ----------

export interface AskUserQuestion {
  question: string;
  multiSelect: boolean;
  options: PermissionOption[];
}

/**
 * Split a zcode AskUserQuestion request into per-question descriptors.
 *
 * Single-select: one ACP option per label + a trailing Skip.
 * Multi-select: each label becomes a yes/no pair (optionId `<label>:yes` /
 * `<label>:no`) so the handler can pop one Include/Skip dialog per option.
 *
 * Returns null when there are no valid questions.
 */
export function splitAskUserQuestions(
  params: ZcodeInteractionUserInputParams,
): AskUserQuestion[] | null {
  // zcode carries questions both at the top level and under input.questions; prefer top level.
  let questions = params.questions;
  if (!questions || questions.length === 0) {
    questions = params.input?.questions ?? [];
  }
  const valid = questions.filter((q) => q && typeof q.question === "string");
  if (valid.length === 0) return null;

  const result: AskUserQuestion[] = [];
  for (const q of valid) {
    const labels: string[] = [];
    for (const opt of q.options ?? []) {
      const label = opt.label ?? opt.value ?? "";
      if (label) labels.push(label);
    }
    if (labels.length === 0) continue;

    const multi = q.multiSelect === true;
    if (multi) {
      const options: PermissionOption[] = [];
      for (const lb of labels) {
        options.push({ optionId: `${lb}:yes`, kind: "allow_once", name: `Include: ${lb}` });
        options.push({ optionId: `${lb}:no`, kind: "reject_once", name: `Skip: ${lb}` });
      }
      result.push({ question: q.question, multiSelect: true, options });
    } else {
      const options: PermissionOption[] = labels.map((lb) => ({
        optionId: lb,
        kind: "allow_once",
        name: lb,
      }));
      options.push({ optionId: "__skip__", kind: "reject_once", name: "Skip" });
      result.push({ question: q.question, multiSelect: false, options });
    }
  }
  return result.length > 0 ? result : null;
}

/** Build ACP requestPermission params for one AskUserQuestion question. */
export function buildAskUserAcpParams(
  params: ZcodeInteractionUserInputParams,
  acpSid: string,
  options: PermissionOption[],
): {
  options: PermissionOption[];
  sessionId: string;
  toolCall: { toolCallId: string; rawInput: unknown };
} {
  return {
    options,
    sessionId: acpSid,
    toolCall: { toolCallId: params.toolCallId ?? "", rawInput: params.input },
  };
}

/**
 * Parse one ACP requestPermission response → "yes" | "no" | label | null.
 *
 * Multi-select: optionId `<label>:yes` → "yes", `<label>:no` → "no".
 * Single-select: optionId is the label; __skip__ / cancel → null.
 */
export function parseAskUserResponse(acpResp: unknown): string | null {
  if (!acpResp || typeof acpResp !== "object") return null;
  const outcome = (acpResp as { outcome?: { outcome?: string; optionId?: string } }).outcome ?? {};
  if (outcome.outcome === "cancelled") return null;
  const optionId = outcome.optionId ?? "";
  if (!optionId || optionId === "__skip__") return null;
  if (optionId.endsWith(":yes")) return "yes";
  if (optionId.endsWith(":no")) return "no";
  return optionId;
}
