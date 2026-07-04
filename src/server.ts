/**
 * ZcodeAcpServer — owns shared server state and registers ACP handlers.
 *
 * This class is the long-lived container that the entry point wires to the
 * ACP stream. Handlers are registered incrementally as features are added;
 * for now only `initialize` is wired. Subsequent commits add session
 * lifecycle, translation, interaction, config, and extension handlers.
 */

import type * as acp from "@agentclientprotocol/sdk";

import { AGENT_INFO, PROTOCOL_VERSION, log } from "./utils.js";

/** Client capabilities advertised in the initialize request. */
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  auth?: Record<string, unknown>;
  elicitation?: { form?: unknown; url?: unknown };
  _meta?: Record<string, unknown>;
}

export class ZcodeAcpServer {
  /** acp_sid → zcode session id (usually identical, but kept for clarity). */
  readonly sessionMap = new Map<string, string>();
  /** Currently running turns, keyed by the ACP request id. */
  readonly pendingTurns = new Map<
    number,
    { zcodeSid: string; cancelled: boolean; permResponses: Map<number, unknown> }
  >();
  /** Capabilities advertised by the connected client (Zed, JetBrains, ...). */
  clientCapabilities: ClientCapabilities = {};
  /** Session titles already set, to enforce set-once (acp_sid → title). */
  readonly sessionTitles = new Map<string, string>();

  /** Handle `initialize`: negotiate version + declare agent capabilities. */
  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    const clientInfo = (params.clientInfo as { name?: string; version?: string } | null) ?? null;
    this.clientCapabilities = (params.clientCapabilities as ClientCapabilities) ?? {};
    log(
      `initialize: client protocolVersion=${params.protocolVersion}` +
        `, client=${clientInfo?.name ?? "unknown"}` +
        `, version=${clientInfo?.version ?? "unknown"}`,
    );

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { ...AGENT_INFO },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, resume: {}, fork: {} },
        auth: {},
      },
      authMethods: [],
    };
  }
}
