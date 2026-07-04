/**
 * ZcodeAcpServer — owns shared server state, the backend client, and registers
 * ACP handlers.
 *
 * This is the long-lived container the entry point wires to the ACP stream.
 * Shared state (session map, pending turns, client capabilities) lives here so
 * every handler layer can reach it without globals.
 */

import type * as acp from "@agentclientprotocol/sdk";

import {
  loadZcodeCredentials,
  mergeEnvWithCreds,
  resolveZcodeCommand,
  ZcodeBackend,
} from "./backend/index.js";
import { AGENT_INFO, PROTOCOL_VERSION, log } from "./utils.js";

/** Client capabilities advertised in the initialize request. */
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  auth?: Record<string, unknown>;
  elicitation?: { form?: unknown; url?: unknown };
  _meta?: Record<string, unknown>;
}

/** A pending prompt turn. */
export interface PendingTurn {
  zcodeSid: string;
  cancelled: boolean;
  /** Client responses to server→client requests, keyed by ACP request id. */
  permResponses: Map<number, unknown>;
}

export class ZcodeAcpServer {
  /** The ZCode subprocess client (lazy — spawned on first use). */
  backend: ZcodeBackend | null = null;
  /** acp_sid → zcode session id (usually identical, but kept for clarity). */
  readonly sessionMap = new Map<string, string>();
  /** Currently running turns, keyed by the ACP request id. */
  readonly pendingTurns = new Map<number, PendingTurn>();
  /** Capabilities advertised by the connected client (Zed, JetBrains, ...). */
  clientCapabilities: ClientCapabilities = {};
  /** Session titles already set, to enforce set-once (acp_sid → title). */
  readonly sessionTitles = new Map<string, string>();
  /** Per-session ProjectionDiffers (persists across turns). */
  readonly differs = new Map<
    string,
    import("./translators/projection-differ.js").ProjectionDiffer
  >();
  /** Per-session model cache (Commit 7). */
  readonly modelCache = new Map<string, string>();
  /** Monotonic id counter; base 10_000_000 to avoid collisions with zcode-originated ids. */
  private msgCounter = 10_000_000;

  /** Next JSON-RPC id for messages we send to zcode. */
  nextId(): number {
    return ++this.msgCounter;
  }

  /** Lazily spawn the zcode backend on first use (initialize doesn't need it). */
  ensureBackend(): ZcodeBackend {
    if (this.backend && !this.backend.isDead) return this.backend;
    const env = mergeEnvWithCreds(loadZcodeCredentials());
    const argv = resolveZcodeCommand();
    this.backend = new ZcodeBackend(argv, env);
    return this.backend;
  }

  /** Resolve the zcode session id for an ACP session id. */
  resolveSid(acpSid: string): string | undefined {
    return this.sessionMap.get(acpSid);
  }

  /** Whether the client declared `_meta.terminal_output` (Zed's Bash UI hook). */
  supportsTerminalOutput(): boolean {
    const meta = this.clientCapabilities._meta ?? {};
    return meta["terminal_output"] === true;
  }

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
