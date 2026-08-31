/**
 * Native ACP telemetry integration.
 *
 * Only already-parsed lifecycle metadata is passed to the shared observer.
 * Every entry point is no-throw so observability can never affect ACP traffic.
 */

import { createAcpObserverFromEnv, type AcpObserver } from "@buzz-agent-observability/acp-observer";

import { AGENT_INFO } from "./utils.js";

const UNKNOWN_ERROR_CODE = -32_603;
const IDENTITY_KEYS = new Set([
  "BUZZ_TELEMETRY_AGENT_ID",
  "BUZZ_ACP_DISPLAY_NAME",
  "BUZZ_GIT_ORIGIN_AGENT_NAME",
]);

let activeObserver: AcpObserver | undefined;

function observer(): AcpObserver {
  if (!activeObserver) {
    activeObserver = createAcpObserverFromEnv({
      harness: "zcode",
      harnessVersion: AGENT_INFO.version,
      model: process.env.ZCODE_MODEL ?? process.env.ZCODE_MODEL_ID ?? null,
      producerName: "buzz-zcode-harness",
      producerVersion: AGENT_INFO.version,
    });
  }
  return activeObserver;
}

function safely(action: (value: AcpObserver) => void): void {
  try {
    action(observer());
  } catch {
    // Telemetry is strictly fail-open.
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function identityEnvironment(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const item = record(entry);
      return typeof item.name === "string" &&
        IDENTITY_KEYS.has(item.name) &&
        typeof item.value === "string"
        ? [{ name: item.name, value: item.value }]
        : [];
    });
  }
  const source = record(value);
  return Object.fromEntries(
    [...IDENTITY_KEYS]
      .filter((key) => typeof source[key] === "string")
      .map((key) => [key, source[key]]),
  );
}

function clientParams(method: string, value: unknown): Record<string, unknown> {
  const params = record(value);
  if (method === "session/new") {
    const servers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
    return {
      mcpServers: servers.map((server) => ({ env: identityEnvironment(record(server).env) })),
    };
  }
  return typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {};
}

function serverResult(method: string, value: unknown): Record<string, unknown> {
  const result = record(value);
  if (method === "session/new" && typeof result.sessionId === "string") {
    return { sessionId: result.sessionId };
  }
  if (method === "session/prompt" && typeof result.stopReason === "string") {
    return { stopReason: result.stopReason };
  }
  return {};
}

function sessionUpdate(value: unknown): Record<string, unknown> {
  const update = record(value);
  const kind = update.sessionUpdate;
  if (typeof kind !== "string") return {};
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content = record(update.content);
    return {
      sessionUpdate: kind,
      content: { type: "text", text: typeof content.text === "string" && content.text ? "1" : "" },
    };
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    return {
      sessionUpdate: kind,
      ...(typeof update.toolCallId === "string" ? { toolCallId: update.toolCallId } : {}),
      ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
      ...(typeof update.status === "string" ? { status: update.status } : {}),
    };
  }
  if (kind === "usage_update") {
    return { sessionUpdate: kind, used: update.used };
  }
  return { sessionUpdate: kind };
}

export function observeClientRequest(method: string, id: number | string, params: unknown): void {
  safely((value) =>
    value.observeClientMessage({
      jsonrpc: "2.0",
      id,
      method,
      params: clientParams(method, params),
    }),
  );
}

export function observeClientNotification(method: string, params: unknown): void {
  safely((value) =>
    value.observeClientMessage({ jsonrpc: "2.0", method, params: clientParams(method, params) }),
  );
}

export function observeServerResult(method: string, id: number | string, result: unknown): void {
  safely((value) =>
    value.observeServerMessage({ jsonrpc: "2.0", id, result: serverResult(method, result) }),
  );
}

export function observeServerError(id: number | string): void {
  safely((value) =>
    value.observeServerMessage({
      jsonrpc: "2.0",
      id,
      error: { code: UNKNOWN_ERROR_CODE },
    }),
  );
}

export function observeSessionUpdate(sessionId: string, update: unknown): void {
  safely((value) =>
    value.observeServerMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: sessionUpdate(update) },
    }),
  );
}

export async function withObservedRequest<T>(
  method: string,
  id: number | string,
  params: unknown,
  handler: () => Promise<T> | T,
): Promise<T> {
  observeClientRequest(method, id, params);
  try {
    const result = await handler();
    observeServerResult(method, id, result);
    return result;
  } catch (error) {
    observeServerError(id);
    throw error;
  }
}

export async function finishTelemetry(details: { code: number; signal?: string }): Promise<void> {
  safely((value) => value.observeProcessExit(details));
  try {
    await observer().flush({ deadlineMs: 50 });
  } catch {
    // Shutdown must proceed even when the collector is unavailable.
  }
}

/** Test seam for proving native hook placement and fail-open behavior. */
export function setTelemetryObserverForTesting(value: AcpObserver | undefined): void {
  activeObserver = value;
}
