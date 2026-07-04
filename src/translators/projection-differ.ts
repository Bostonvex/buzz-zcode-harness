/**
 * ProjectionDiffer: diff two `{projection, messages, todos}` snapshots into
 * internal events.
 *
 * Used in three places:
 *   1. Turn completion — emit the final PlanUpdate / usage (text/tools are
 *      already deduped by seenMessageIds).
 *   2. Stall reconciliation — recover missed events from an authoritative
 *      `session/messages` snapshot.
 *   3. session/load — replay an initial plan.
 *
 * Only NEW messages (by message id dedup) are processed, so multi-turn/resume
 * history isn't re-emitted. The PlanUpdate fires whenever the todos signature
 * changes (including clearing to empty — the initial `_lastPlanSig = "__none__"`
 * makes the first empty list also emit).
 */

import type { ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk";

import type {
  ZcodeMessage,
  ZcodeMessagePart,
  ZcodeProjection,
  ZcodeSnapshot,
} from "../backend/types.js";
import {
  buildDiffContent,
  buildResultContent,
  extractLocations,
  renderToolOutput,
  summarizeToolInput,
  TOOL_KIND_MAP,
} from "./tool-helpers.js";
import type { InternalEvent } from "./types.js";
import { makePlanEntry } from "./types.js";

const TOOL_STATUS_MAP: Record<string, ToolCallStatus> = {
  pending: "pending",
  running: "in_progress",
  completed: "completed",
  error: "failed",
};

export class ProjectionDiffer {
  private readonly seenToolIds = new Set<string>();
  private readonly lastToolStatus = new Map<string, string>();
  private lastUsage: number | null = null;
  private readonly seenMessageIds = new Set<string>();
  private lastPlanSig = "__none__";
  private readonly seenPatchHashes = new Set<string>();
  /** Whether any TextDelta fired this turn (used by fallback detection). */
  emittedTextThisTurn = false;

  /** Mark all given messages as seen (baseline so we don't re-emit history). */
  markSeen(messages: ZcodeMessage[]): void {
    for (const m of messages) {
      const key = this.messageDedupKey(m);
      if (key) this.seenMessageIds.add(key);
    }
  }

  /** Reset per-turn flags (does NOT reset seenMessageIds). */
  resetTurn(): void {
    this.emittedTextThisTurn = false;
  }

  /** Diff two snapshots. Returns 0..n events. */
  diff(curSnapshot: ZcodeSnapshot | null): InternalEvent[] {
    const events: InternalEvent[] = [];
    const curProj = (curSnapshot?.projection ?? {}) as ZcodeProjection;
    const curMsgs = curSnapshot?.messages ?? [];

    // 1. usage_update: prefer contextUsed (current occupancy) over totalTokenCount (cumulative).
    const used = curProj.contextUsed ?? curProj.totalTokenCount ?? 0;
    const size = curProj.contextWindow ?? 0;
    if (this.lastUsage === null || used !== this.lastUsage) {
      if (size > 0) events.push({ kind: "UsageDelta", used, size });
      this.lastUsage = used;
    }

    // 2. Only NEW messages (dedup by id).
    for (const m of curMsgs) {
      const dedupKey = this.messageDedupKey(m);
      if (dedupKey && this.seenMessageIds.has(dedupKey)) continue;
      if (dedupKey) this.seenMessageIds.add(dedupKey);
      const role = m.info?.role;
      for (const p of m.parts ?? []) {
        if (!p || typeof p !== "object") continue;
        const ptype = (p as { type?: string }).type;
        if (ptype === "tool") {
          events.push(...this.diffToolPart(p as ZcodeMessagePart & Record<string, unknown>));
        } else if (ptype === "text" && role === "assistant") {
          const text = (p as { text?: string }).text ?? "";
          if (text.trim()) {
            events.push({ kind: "TextDelta", text });
            this.emittedTextThisTurn = true;
          }
        } else if (ptype === "reasoning") {
          const text = (p as { text?: string }).text ?? "";
          if (text.trim()) events.push({ kind: "ReasoningDelta", text });
        } else if (ptype === "patch") {
          const ph = (p as { hash?: string }).hash;
          if (ph && !this.seenPatchHashes.has(ph)) {
            this.seenPatchHashes.add(ph);
            events.push({ kind: "FilesChanged", files: (p as { files?: string[] }).files ?? [] });
          }
        }
      }
    }

    // 3. plan (todos) — including clearing to empty.
    const todos = (curSnapshot?.todos ?? []) as Array<Record<string, unknown>>;
    const sig = stableStringify(todos);
    if (sig !== this.lastPlanSig) {
      this.lastPlanSig = sig;
      const entries = todos.map((t) =>
        makePlanEntry(
          String(t["content"] ?? ""),
          String(t["status"] ?? "pending"),
          String(t["priority"] ?? "medium"),
        ),
      );
      events.push({ kind: "PlanUpdate", entries });
    }
    return events;
  }

  private diffToolPart(p: ZcodeMessagePart & Record<string, unknown>): InternalEvent[] {
    const events: InternalEvent[] = [];
    const callId = String(p["callID"] ?? p["callId"] ?? "");
    if (!callId) return events;
    const toolName = String(p["tool"] ?? "other");
    const state = (p["state"] as Record<string, unknown>) ?? {};
    const status = String(state["status"] ?? "pending");

    if (!this.seenToolIds.has(callId)) {
      this.seenToolIds.add(callId);
      this.lastToolStatus.set(callId, status);
      const input = state["input"];
      const summary = summarizeToolInput(toolName, input);
      const newEv: InternalEvent = {
        kind: "ToolCallNew",
        callId,
        tool: toolName,
        acpKind: (TOOL_KIND_MAP[toolName] ?? "other") as ToolKind,
        status: (TOOL_STATUS_MAP[status] ?? "other") as ToolCallStatus,
        title: summary ? `${toolName}: ${summary}` : toolName,
      };
      if (input !== undefined) (newEv as { input?: unknown }).input = input;
      const display = (state["metadata"] as Record<string, unknown> | undefined)?.["display"];
      if (status === "completed" || status === "error") {
        const outPayload = state["output"] ?? state["error"];
        (newEv as { output?: string }).output = renderToolOutput(outPayload);
        const diff = buildDiffContent(display);
        if (diff.length > 0) {
          (newEv as { diffContent?: typeof diff }).diffContent = diff;
        } else {
          const rc = buildResultContent(toolName, outPayload, status === "error");
          if (rc.length > 0) (newEv as { content?: typeof rc }).content = rc;
        }
      }
      const locs = extractLocations(toolName, input, display);
      if (locs.length > 0) (newEv as { locations?: typeof locs }).locations = locs;
      events.push(newEv);
    } else if (status !== this.lastToolStatus.get(callId)) {
      this.lastToolStatus.set(callId, status);
      events.push({
        kind: "ToolCallUpdate",
        callId,
        status: (TOOL_STATUS_MAP[status] ?? "other") as ToolCallStatus,
      });
    }
    return events;
  }

  private messageDedupKey(m: ZcodeMessage): string | null {
    const info = (m.info ?? {}) as { id?: string; role?: string };
    const msgId = info.id;
    if (msgId) return msgId;
    const role = info.role ?? "?";
    try {
      const sig = JSON.stringify(m.parts ?? []).slice(0, 200);
      return `__fallback::${role}::${sig}`;
    } catch {
      return `__fallback::${role}::${String(m.parts).slice(0, 200)}`;
    }
  }
}

/** Deterministic JSON string (sorted keys) for signature comparison. */
function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
