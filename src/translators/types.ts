/**
 * Internal event-dict shape — the seam between translators and the dispatcher.
 *
 * Both `EventTranslator` (event-stream path) and `ProjectionDiffer` (snapshot
 * path) emit these discriminated unions; `dispatchEvent` consumes them and
 * serialises each into an ACP `session/update` notification.
 */

import type {
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

export interface ToolCallNewEvent {
  kind: "ToolCallNew";
  callId: string;
  tool: string;
  acpKind: ToolKind;
  status: ToolCallStatus;
  title: string;
  input?: unknown;
  output?: string;
  content?: ToolCallContent[];
  diffContent?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

export interface ToolCallUpdateEvent {
  kind: "ToolCallUpdate";
  callId: string;
  tool?: string;
  status: ToolCallStatus;
  output?: string;
  rawOutput?: unknown;
  rawResult?: unknown;
  content?: ToolCallContent[];
  diffContent?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

export interface UsageDeltaEvent {
  kind: "UsageDelta";
  used: number;
  size: number;
}

export interface TextDeltaEvent {
  kind: "TextDelta";
  text: string;
}

export interface ReasoningDeltaEvent {
  kind: "ReasoningDelta";
  text: string;
}

export interface PlanUpdateEvent {
  kind: "PlanUpdate";
  entries: PlanEntry[];
}

/** A plan entry being built before dispatch (status/priority are normalised here). */
export function makePlanEntry(content: string, status: string, priority?: string): PlanEntry {
  return {
    content,
    status: normalisePlanStatus(status),
    priority: normalisePlanPriority(priority),
  };
}

function normalisePlanStatus(s: string): PlanEntryStatus {
  if (s === "completed" || s === "in_progress" || s === "pending") {
    return s;
  }
  return "pending";
}

function normalisePlanPriority(p: string | undefined): PlanEntryPriority {
  if (p === "high" || p === "medium" || p === "low") return p;
  return "medium";
}

export interface FilesChangedEvent {
  kind: "FilesChanged";
  files: string[];
}

export type InternalEvent =
  | ToolCallNewEvent
  | ToolCallUpdateEvent
  | UsageDeltaEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | PlanUpdateEvent
  | FilesChangedEvent;
