declare module "@buzz-agent-observability/acp-observer" {
  export interface AcpObserver {
    observeClientMessage(message: unknown, monotonicNow?: number): void;
    observeServerMessage(message: unknown, monotonicNow?: number): void;
    observeProcessExit(details?: { code?: number; signal?: string }, monotonicNow?: number): void;
    flush(options?: { deadlineMs?: number }): Promise<unknown>;
  }

  export interface AcpObserverEnvironmentOverrides {
    harness?: string;
    harnessVersion?: string;
    model?: string | null;
    endpointId?: string;
    toolObservationMode?: "acp_updates" | "execution_hook" | "unavailable";
    producerName?: string;
    producerVersion?: string;
  }

  export function createAcpObserverFromEnv(
    overrides?: AcpObserverEnvironmentOverrides,
    environment?: NodeJS.ProcessEnv,
  ): AcpObserver;
}
