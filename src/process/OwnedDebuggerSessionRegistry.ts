import type {
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  closeOwnedDebuggerSessions,
  retainedDebuggerCleanupFailure,
  type OwnedDebuggerStopResult,
} from "./ownedDebuggerSession.js";

/** What the registry needs from a persistent debugger session it owns. */
export interface RegisteredDebuggerSession {
  readonly id: string;
  readonly launched: {
    readonly process: { readonly pid?: number | undefined };
  };
  readonly supervisor: { ref(): void; unref(): void };
}

export interface OwnedDebuggerSessionRegistryOptions<Session> {
  /** Provider id used for retained capability failures. */
  readonly provider: string;
  /** Debugger name shown in cleanup failures, such as "GDB". */
  readonly displayName: string;
  /** Operation a retained failure names when no caller operation applies. */
  readonly closeOperation: string;
  /** Seal the session against new commands; runs on every stop request. */
  readonly sealSession: (session: Session) => void;
  /** Stop the owned debugger process; protocol hooks stay with the adapter. */
  readonly stopProcess: (session: Session) => Promise<OwnedDebuggerStopResult>;
  /** Prefix for a stop that threw instead of reporting an outcome. */
  readonly stopFailurePrefix: string;
}

/**
 * Owns the persistent sessions of one debugger: the published session map,
 * start reservations against its capacity, one in-flight stop per session,
 * cleanup failures retained until a stop is confirmed, cleanup retry, and
 * closing every session. Each debugger keeps its protocol, detach and
 * stop-reason policy.
 */
export class OwnedDebuggerSessionRegistry<
  Session extends RegisteredDebuggerSession,
> {
  readonly #options: OwnedDebuggerSessionRegistryOptions<Session>;
  readonly #sessions = new Map<string, Session>();
  readonly #cleanupFailures = new WeakMap<Session, Set<AnalysisError>>();
  readonly #stopAttempts = new WeakMap<
    Session,
    Promise<OwnedDebuggerStopResult>
  >();
  #reservations = 0;

  constructor(options: OwnedDebuggerSessionRegistryOptions<Session>) {
    this.#options = options;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  values(): IterableIterator<Session> {
    return this.#sessions.values();
  }

  /** Publish a started session under its ID. */
  add(session: Session): void {
    this.#sessions.set(session.id, session);
  }

  /** Forget a session whose owned cleanup completed; a replacement is kept. */
  remove(session: Session): void {
    if (this.#sessions.get(session.id) === session)
      this.#sessions.delete(session.id);
  }

  /** Published sessions plus starts holding a reservation. */
  occupied(): number {
    return this.#sessions.size + this.#reservations;
  }

  /** Reserve one capacity slot for a start; the release is idempotent. */
  reserve(): () => void {
    this.#reservations += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#reservations -= 1;
    };
  }

  /** Whether a stop of this session is in flight. */
  stopping(session: Session): boolean {
    return this.#stopAttempts.has(session);
  }

  /**
   * Stop the owned debugger process, sharing one attempt between concurrent
   * callers. A confirmed stop resolves every retained cleanup failure.
   */
  stop(session: Session): Promise<OwnedDebuggerStopResult> {
    this.#options.sealSession(session);
    const active = this.#stopAttempts.get(session);
    if (active !== undefined) return active;
    const attempt = Promise.resolve()
      .then(() => this.#options.stopProcess(session))
      .catch((cause: unknown): OwnedDebuggerStopResult => ({
        status: "incomplete",
        reason: `${this.#options.stopFailurePrefix}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }))
      .then((stopped) => {
        if (stopped.status !== "incomplete") {
          const retained = this.#cleanupFailures.get(session);
          for (const failure of retained ?? []) failure.resolveCleanup();
          retained?.clear();
        }
        return stopped;
      })
      .finally(() => {
        if (this.#stopAttempts.get(session) === attempt)
          this.#stopAttempts.delete(session);
      });
    this.#stopAttempts.set(session, attempt);
    return attempt;
  }

  /** Keep a failure whose cleanup is incomplete until a stop is confirmed. */
  retain(session: Session, failure: AnalysisError): AnalysisError {
    let retained = this.#cleanupFailures.get(session);
    if (retained === undefined) {
      retained = new Set();
      this.#cleanupFailures.set(session, retained);
    }
    retained.add(failure);
    return failure;
  }

  /** Retain the failure of an operation that could not confirm the stop. */
  retainCleanupFailure(
    session: Session,
    operation: string,
    reason: string,
    options: AnalysisErrorOptions = {},
  ): AnalysisError {
    return this.retain(
      session,
      retainedDebuggerCleanupFailure(
        {
          provider: this.#options.provider,
          displayName: this.#options.displayName,
        },
        operation,
        reason,
        [session.id],
        options,
      ),
    );
  }

  /**
   * Stop each session that retains a cleanup failure. A session that stops
   * is forgotten unless `keepAddressable` holds: the caller still holds a
   * published session's ID, so status keeps reporting why it stopped until
   * it is closed.
   */
  async retryCleanupFailures(
    keepAddressable: (session: Session) => boolean,
  ): Promise<Result<null, AnalysisError>> {
    for (const session of this.#sessions.values()) {
      const retained = this.#cleanupFailures.get(session);
      if (retained === undefined || retained.size === 0) continue;
      const stopped = await this.stop(session);
      if (stopped.status === "incomplete")
        return err(
          [...retained].at(-1) ??
            this.retainCleanupFailure(
              session,
              this.#options.closeOperation,
              stopped.reason,
            ),
        );
      if (!keepAddressable(session)) this.remove(session);
    }
    return ok(null);
  }

  /**
   * Stop every session; sessions whose stop is incomplete stay registered for
   * retry. Callers block new starts and drain in-flight ones first.
   */
  closeAll(): Promise<void> {
    return closeOwnedDebuggerSessions(
      this.#sessions,
      (session) => this.stop(session),
      this.#options.displayName,
    );
  }
}
