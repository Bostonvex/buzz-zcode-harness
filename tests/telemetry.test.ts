/** Native ZCode telemetry hook placement and privacy-boundary tests. */

import type * as acp from "@agentclientprotocol/sdk";
import type { AcpObserver } from "@buzz-agent-observability/acp-observer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendSessionUpdate } from "../src/handlers/io.js";
import { replayMessages } from "../src/handlers/replay.js";
import { ZcodeAcpServer } from "../src/server.js";
import {
  observeSessionUpdate,
  setTelemetryObserverForTesting,
  withObservedRequest,
} from "../src/telemetry.js";

interface FakeObserver extends AcpObserver {
  observeClientMessage: ReturnType<typeof vi.fn>;
  observeServerMessage: ReturnType<typeof vi.fn>;
  observeProcessExit: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}

function fakeObserver(shouldThrow = false): FakeObserver {
  const action = () => {
    if (shouldThrow) throw new Error("collector unavailable");
  };
  return {
    observeClientMessage: vi.fn(action),
    observeServerMessage: vi.fn(action),
    observeProcessExit: vi.fn(action),
    flush: vi.fn(async () => {
      action();
    }),
  } as FakeObserver;
}

function context(notify = vi.fn(async () => undefined)): acp.AgentContext {
  return { notify, request: vi.fn(async () => ({})) } as unknown as acp.AgentContext;
}

afterEach(() => setTelemetryObserverForTesting(undefined));

describe("native telemetry boundary", () => {
  it("observes lifecycle metadata while removing content and arbitrary fields", async () => {
    const observer = fakeObserver();
    setTelemetryObserverForTesting(observer);

    await withObservedRequest(
      "session/new",
      1,
      {
        cwd: "/private/workspace",
        mcpServers: [
          {
            command: "private-command",
            env: [
              { name: "BUZZ_ACP_DISPLAY_NAME", value: "Agent Seven" },
              { name: "PRIVATE_TOKEN", value: "do-not-observe" },
            ],
          },
        ],
      },
      async () => ({ sessionId: "session-raw", privateResult: "not-observed" }),
    );
    await withObservedRequest(
      "session/prompt",
      2,
      {
        sessionId: "session-raw",
        prompt: [{ type: "text", text: "private prompt body" }],
        _meta: { secret: "private metadata" },
      },
      async () => ({ stopReason: "end_turn", privateResult: "not-observed" }),
    );
    observeSessionUpdate("session-raw", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-raw",
      kind: "read",
      status: "in_progress",
      title: "Read /private/path",
      rawInput: { path: "/private/path" },
      rawOutput: "private tool output",
    });

    const observed = JSON.stringify([
      ...observer.observeClientMessage.mock.calls,
      ...observer.observeServerMessage.mock.calls,
    ]);
    expect(observed).toContain("Agent Seven");
    expect(observed).toContain("session-raw");
    expect(observed).toContain("tool-raw");
    for (const secret of [
      "/private/workspace",
      "private-command",
      "do-not-observe",
      "private prompt body",
      "private metadata",
      "privateResult",
      "/private/path",
      "private tool output",
    ]) {
      expect(observed).not.toContain(secret);
    }
  });

  it("observes a live update exactly once without changing delivery", async () => {
    const observer = fakeObserver();
    setTelemetryObserverForTesting(observer);
    const notify = vi.fn(async () => undefined);
    const update = {
      sessionUpdate: "usage_update",
      used: 1_024,
      size: 32_768,
    } as unknown as acp.SessionUpdate;

    await sendSessionUpdate(context(notify), "session-live", update);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("session/update", {
      sessionId: "session-live",
      update,
    });
    expect(observer.observeServerMessage).toHaveBeenCalledOnce();
    expect(observer.observeServerMessage).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-live",
        update: { sessionUpdate: "usage_update", used: 1_024 },
      },
    });
  });

  it("keeps live delivery and request results fail-open when the observer throws", async () => {
    const observer = fakeObserver(true);
    setTelemetryObserverForTesting(observer);
    const notify = vi.fn(async () => undefined);

    await expect(
      sendSessionUpdate(context(notify), "session-live", {
        sessionUpdate: "plan",
        entries: [],
      }),
    ).resolves.toBeUndefined();
    await expect(
      withObservedRequest("session/prompt", 3, { sessionId: "session-live" }, async () => ({
        stopReason: "end_turn",
      })),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not count replayed history as live turn activity", async () => {
    const observer = fakeObserver();
    setTelemetryObserverForTesting(observer);
    const notify = vi.fn(async () => undefined);

    await replayMessages(context(notify), "session-replay", [
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "old prompt" }] },
      { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "old answer" }] },
    ]);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(observer.observeServerMessage).not.toHaveBeenCalled();
  });

  it("does not attribute out-of-band background broadcasts to the active turn", async () => {
    const observer = fakeObserver();
    setTelemetryObserverForTesting(observer);
    const server = new ZcodeAcpServer();
    const notify = vi.fn(async () => undefined);
    server.clients.add({ notify, request: vi.fn(async () => ({})) });
    server.registerSession("session-background", "zcode-background");

    const delivered = await server.notifyByZcodeSid("zcode-background", {
      sessionUpdate: "tool_call_update",
      toolCallId: "background-tool",
      status: "completed",
    });

    expect(delivered).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    expect(observer.observeServerMessage).not.toHaveBeenCalled();
  });
});
