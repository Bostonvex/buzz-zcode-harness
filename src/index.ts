#!/usr/bin/env node

/**
 * Entry point: wire the ZcodeAcpServer to a stdio ACP stream.
 *
 * The ACP SDK provides `ndJsonStream(output, input)` which frames newline-
 * delimited JSON-RPC over a pair of web streams. We convert Node's stdin/
 * stdout to web streams and hand them off. Everything else (request/response
 * correlation, param validation, AbortSignal plumbing) is handled by the SDK.
 */

import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";
import { Readable, Writable } from "node:stream";

import {
  cancel,
  listSessions,
  loadSession,
  newSession,
  prompt,
  resumeSession,
  setConfigOptionHandler,
} from "./handlers/session.js";
import {
  cancelBackgroundTask,
  compact,
  fork,
  goal,
  rewind,
  rewindCascade,
  setMode,
  setModel,
  setThoughtLevel,
  steer,
  updateRuntimeModelConfig,
} from "./handlers/extensions.js";
import { ZcodeAcpServer } from "./server.js";
import { AGENT_INFO, log } from "./utils.js";

async function main(): Promise<void> {
  // stdout is the outbound channel to the client; stdin is inbound.
  const outbound = Writable.toWeb(process.stdout);
  const inbound = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  const stream = acp.ndJsonStream(outbound, inbound);
  const server = new ZcodeAcpServer();

  /** Passthrough params parser for the ZCode-specific extension methods. */
  const extParams = z.object({ sessionId: z.string() }).passthrough();

  log(`starting ${AGENT_INFO.name} ${AGENT_INFO.version}, ACP protocol v${acp.PROTOCOL_VERSION}`);

  acp
    .agent({ name: AGENT_INFO.name })
    .onRequest("initialize", (ctx) => server.initialize(ctx.params))
    .onRequest("session/new", (ctx) => newSession(server, ctx.params))
    .onRequest("session/list", (ctx) => listSessions(server, ctx.params))
    .onRequest("session/resume", (ctx) => resumeSession(server, ctx.params))
    .onRequest("session/load", (ctx) => loadSession(server, ctx.params, ctx.client))
    .onRequest("session/prompt", (ctx) =>
      prompt(server, ctx.params, ctx.client, ctx.requestId as number),
    )
    .onRequest("session/set_config_option", (ctx) =>
      setConfigOptionHandler(server, ctx.params, ctx.client),
    )
    // ZCode-specific extensions (non-standard ACP methods). Use a passthrough
    // zod parser so all param fields survive into the handler.
    .onRequest("session/fork", extParams, (ctx) => fork(server, ctx.params))
    .onRequest("session/rewind", extParams, (ctx) => rewind(server, ctx.params))
    .onRequest("session/rewindCascade", extParams, (ctx) => rewindCascade(server, ctx.params))
    .onRequest("session/goal", extParams, (ctx) => goal(server, ctx.params))
    .onRequest("session/compact", extParams, (ctx) => compact(server, ctx.params, ctx.client))
    .onRequest("session/steer", extParams, (ctx) => steer(server, ctx.params))
    .onRequest("session/cancelBackgroundTask", extParams, (ctx) =>
      cancelBackgroundTask(server, ctx.params),
    )
    .onRequest("session/setThoughtLevel", extParams, (ctx) => setThoughtLevel(server, ctx.params))
    .onRequest("session/updateRuntimeModelConfig", extParams, (ctx) =>
      updateRuntimeModelConfig(server, ctx.params),
    )
    .onRequest("session/setModel", extParams, (ctx) => setModel(server, ctx.params))
    .onRequest("session/setMode", extParams, (ctx) => setMode(server, ctx.params, ctx.client))
    .onNotification("session/cancel", (ctx) => cancel(server, ctx.params))
    .connect(stream);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
