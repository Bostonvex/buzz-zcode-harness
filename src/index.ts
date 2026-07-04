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
import { Readable, Writable } from "node:stream";

import {
  cancel,
  listSessions,
  loadSession,
  newSession,
  prompt,
  resumeSession,
} from "./handlers/session.js";
import { ZcodeAcpServer } from "./server.js";
import { AGENT_INFO, log } from "./utils.js";

async function main(): Promise<void> {
  // stdout is the outbound channel to the client; stdin is inbound.
  const outbound = Writable.toWeb(process.stdout);
  const inbound = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  const stream = acp.ndJsonStream(outbound, inbound);
  const server = new ZcodeAcpServer();

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
    .onNotification("session/cancel", (ctx) => cancel(server, ctx.params))
    .connect(stream);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
