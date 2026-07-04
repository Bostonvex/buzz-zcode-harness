/**
 * Event-stream listener and turn monitor.
 *
 * `EventStreamListener` subscribes to ZCode's `session/subscribe` event push
 * (deliveryKind `desktop-continuous`) and queues `session/event` notifications
 * for the turn loop to consume. It tracks a `lastSeq` watermark and can
 * resubscribe from it to recover missed events after a stall.
 *
 * `TurnMonitor` is the legacy snapshot path: a one-shot `session/read` that
 * returns the authoritative projection. Used for stall reconciliation and
 * lock-release probing.
 */

import type { ZcodeBackend } from "./client.js";
import type { ZcodeEvent, ZcodeProjection, ZcodeSnapshot, ZcodeSubscribeResult } from "./types.js";

/** ID generator function (the server's `_next_id`). */
export type NextId = () => number;

export class EventStreamListener {
  private readonly backend: ZcodeBackend;
  readonly sid: string;
  /** High-watermark of consumed event sequence numbers. */
  lastSeq = 0;
  subscribed = false;
  private readonly queue: ZcodeEvent[] = [];
  private readonly waiters: Array<(ev: ZcodeEvent | null) => void> = [];

  constructor(backend: ZcodeBackend, zcodeSid: string) {
    this.backend = backend;
    this.sid = zcodeSid;
  }

  /**
   * Subscribe and capture the initial snapshot + eventSeq watermark.
   *
   * Returns the snapshot (with projection/messages) or null on failure. ZCode
   * CLI 0.14.8+ always supports this; null means an old/ broken backend and
   * the caller should surface an error (polling fallback was removed).
   */
  async subscribe(nextId: NextId): Promise<ZcodeSnapshot | null> {
    const resp = await this.backend.request(
      nextId(),
      "session/subscribe",
      {
        sessionId: this.sid,
        deliveryKind: "desktop-continuous",
        includeSnapshot: true,
        afterSeq: 0,
      },
      10000,
    );
    if (resp.error) {
      return null;
    }
    const result = (resp.result ?? {}) as ZcodeSubscribeResult;
    this.lastSeq = result.eventSeq ?? 0;
    this.subscribed = true;
    return result.snapshot ?? null;
  }

  /** Called by the backend reader when a `session/event` arrives. */
  handleEvent(event: ZcodeEvent): void {
    if (event.seq > this.lastSeq) this.lastSeq = event.seq;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      this.queue.push(event);
    }
  }

  /**
   * Wait for the next event, resolving once one arrives or `timeoutMs` elapses
   * (resolves null on timeout). Events arriving with no waiter are queued.
   */
  pollEvent(timeoutMs = 500): Promise<ZcodeEvent | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      const wrapped = (ev: ZcodeEvent | null) => {
        clearTimeout(timer);
        resolve(ev);
      };
      this.waiters.push(wrapped);
    });
  }

  /**
   * Stall recovery: resubscribe from `lastSeq` so the server replays missed
   * events. Failure is logged but non-fatal — the caller degrades to polling.
   * The snapshot (if returned despite `includeSnapshot:false`) is intentionally
   * not consumed; resubscribe only refreshes the watermark + resumes the push.
   */
  async resubscribe(nextId: NextId): Promise<boolean> {
    const resp = await this.backend.request(
      nextId(),
      "session/subscribe",
      {
        sessionId: this.sid,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
        afterSeq: this.lastSeq,
      },
      10000,
    );
    if (resp.error) {
      return false;
    }
    const result = (resp.result ?? {}) as ZcodeSubscribeResult;
    if ((result.eventSeq ?? this.lastSeq) > this.lastSeq) {
      this.lastSeq = result.eventSeq ?? this.lastSeq;
    }
    return true;
  }
}

/**
 * Legacy snapshot path: a single `session/read` returning the authoritative
 * projection. Used in stall reconciliation and lock-release probing.
 */
export class TurnMonitor {
  private readonly backend: ZcodeBackend;
  private readonly zcodeSid: string;
  private readonly nextId: NextId;

  constructor(backend: ZcodeBackend, zcodeSid: string, nextId: NextId) {
    this.backend = backend;
    this.zcodeSid = zcodeSid;
    this.nextId = nextId;
  }

  /** Returns the projection snapshot, or null on error. */
  async pollOnce(): Promise<ZcodeProjection | null> {
    const resp = await this.backend.request(
      this.nextId(),
      "session/read",
      { sessionId: this.zcodeSid },
      5000,
    );
    if (resp.error) return null;
    const result = (resp.result ?? {}) as { projection?: ZcodeProjection };
    return result.projection ?? null;
  }
}
