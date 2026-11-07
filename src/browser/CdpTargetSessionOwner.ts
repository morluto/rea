import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { CdpConnection } from "./CdpConnection.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";

/** Typed ownership facts shared by transport errors and their adapter projections. */
class CdpTransportCleanupFailure extends ProviderCleanupError {
  constructor(
    readonly cleanupLeases: readonly AnalysisCleanupLease[],
    failure: {
      readonly resources: readonly string[];
      readonly operation: string;
      readonly diagnostics: Readonly<Record<string, JsonValue>>;
      readonly cause: unknown;
    },
  ) {
    super("rea-cdp-browser", failure.resources, failure.diagnostics, {
      operation: failure.operation,
      cause: failure.cause,
    });
    new AnalysisCleanupLeaseGroup(this, cleanupLeases);
  }
}

/** Bind a translated error without interpreting diagnostic cause chains. */
export const bindCdpTransportCleanup = <Failure extends AnalysisError>(
  cause: unknown,
  failure: Failure,
): Failure => {
  if (cause instanceof CdpTransportCleanupFailure)
    new AnalysisCleanupLeaseGroup(failure, cause.cleanupLeases);
  return failure;
};

interface OwnedConnection {
  readonly connection: CdpConnection;
  operation: BrowserObservationOperation;
  readonly resource: string;
  readonly cleanupLease: AnalysisCleanupLease;
  active: boolean;
  activeLeases: number;
  settled: Promise<void>;
  settle: () => void;
  reusableUrl: string | undefined;
  evicted: boolean;
  closingTransport: boolean;
  statusUnsubscribe: (() => void) | undefined;
  cleanup: (() => Promise<void>) | undefined;
  cleanupAttempted: boolean;
  failure: ProviderCleanupError | undefined;
}

/** Retains exact REA-owned CDP transports until their close is observed. */
export class CdpTargetSessionOwner {
  readonly #connections = new Map<CdpConnection, OwnedConnection>();
  readonly #browserSockets = new Map<string, CdpConnection>();
  #closing = false;
  #admissions = 0;
  #closePromise: Promise<void> | undefined;
  readonly #admissionWaiters = new Set<() => void>();

  /** Reuse an admitted healthy browser socket for `url`, or open a new candidate. */
  async acquireBrowserSocket(
    url: string,
    operation: BrowserObservationOperation,
    options: ExecutionOptions,
    limits: {
      readonly maxPayloadBytes?: number;
      readonly commandTimeoutMs: number;
      readonly handshakeTimeoutMs: number;
    },
  ): Promise<{ readonly connection: CdpConnection; readonly reused: boolean }> {
    this.#assertOpen(operation, "browser-endpoint");
    await this.retryPending();
    this.#assertOpen(operation, "browser-endpoint");
    if (options.signal?.aborted === true)
      throw new AnalysisCancelledError(operation, {
        cause: options.signal.reason,
      });
    const existing = this.#browserSockets.get(url);
    if (existing !== undefined) {
      const existingRecord = this.#connections.get(existing);
      if (
        existingRecord !== undefined &&
        existingRecord.failure === undefined &&
        !existingRecord.evicted &&
        existing.isReusable()
      ) {
        if (existingRecord.activeLeases === 0) {
          let settle = (): void => undefined;
          existingRecord.settled = new Promise<void>((resolve) => {
            settle = resolve;
          });
          existingRecord.settle = settle;
          existingRecord.active = true;
        }
        existingRecord.activeLeases += 1;
        existingRecord.operation = operation;
        return {
          connection: existing.withOperation(
            operation,
            limits.commandTimeoutMs,
          ),
          reused: true,
        };
      }
      this.#browserSockets.delete(url);
      if (existingRecord !== undefined) {
        this.#evictRecord(existingRecord);
        if (existingRecord.activeLeases === 0)
          await this.#releaseTransportRecord(existingRecord);
      }
    }
    const connection = await this.connect(
      url,
      operation,
      options,
      "browser-endpoint",
      limits,
    );
    return { connection, reused: false };
  }

  /** Publish a verified browser socket for reuse across subsequent operations. */
  admitBrowserSocket(url: string, connection: CdpConnection): void {
    const root = transportRoot(connection);
    const record = this.#connections.get(root);
    if (record === undefined) return;
    record.reusableUrl = url;
    if (this.#closing || record.evicted || !root.isReusable()) {
      record.evicted = true;
      return;
    }
    const current = this.#browserSockets.get(url);
    if (current === root) return;
    if (current !== undefined) {
      const currentRecord = this.#connections.get(current);
      if (
        current.isReusable() &&
        currentRecord !== undefined &&
        currentRecord.failure === undefined &&
        !currentRecord.evicted
      ) {
        record.evicted = true;
        return;
      }
      this.#browserSockets.delete(url);
      if (currentRecord !== undefined) this.#evictRecord(currentRecord);
    }
    this.#browserSockets.set(url, root);
    let offDisconnect: (() => void) | undefined;
    let offProtocolFailure: (() => void) | undefined;
    const onUnusable = (): void => {
      if (this.#browserSockets.get(url) === root)
        this.#browserSockets.delete(url);
      record.evicted = true;
      record.statusUnsubscribe?.();
      record.statusUnsubscribe = undefined;
      if (record.activeLeases === 0 && !this.#closing) {
        void this.#releaseTransportRecord(record).catch(() => undefined);
      }
    };
    record.statusUnsubscribe = () => {
      offDisconnect?.();
      offProtocolFailure?.();
    };
    offDisconnect = root.onDisconnect(onUnusable);
    offProtocolFailure = root.onProtocolFailure(onUnusable);
  }

  /** Release one operation's lease on a browser socket, closing it when tainted or closing. */
  async releaseBrowserSocket(
    connection: CdpConnection,
    cleanup?: () => Promise<boolean>,
  ): Promise<void> {
    const root = transportRoot(connection);
    const record = this.#connections.get(root);
    if (record === undefined) return;
    let keepSocket = !record.cleanupLease.released;
    let cleanupFailure: unknown;
    if (cleanup !== undefined && !record.cleanupLease.released) {
      try {
        keepSocket = await cleanup();
      } catch (cause: unknown) {
        keepSocket = false;
        cleanupFailure = cause;
      }
    }
    const mustCloseImmediately =
      !keepSocket || !root.isReusable() || record.failure !== undefined;
    const retain =
      !mustCloseImmediately &&
      !this.#closing &&
      !record.evicted &&
      record.reusableUrl !== undefined &&
      this.#browserSockets.get(record.reusableUrl) === root;
    if (!retain) this.#evictRecord(record);
    if (record.activeLeases > 0) record.activeLeases -= 1;
    try {
      if (mustCloseImmediately || (!retain && record.activeLeases === 0))
        await this.#releaseTransportRecord(record, cleanupFailure);
      if (cleanupFailure !== undefined) {
        const failure =
          cleanupFailure instanceof CdpTransportCleanupFailure
            ? cleanupFailure
            : cleanupError(record, cleanupFailure);
        throw failure;
      }
    } finally {
      if (record.activeLeases === 0) {
        record.active = false;
        record.settle();
      }
    }
  }

  /** Evict a browser socket after failed discovery or unconfirmed attachment state. */
  async evictBrowserSocket(connection: CdpConnection): Promise<void> {
    await this.releaseBrowserSocket(connection, async () => false);
  }

  /** Admit and own one WebSocket from handshake completion onward. */
  async connect(
    url: string,
    operation: BrowserObservationOperation,
    options: ExecutionOptions,
    resource: string,
    limits?: {
      readonly maxPayloadBytes?: number;
      readonly commandTimeoutMs?: number;
      readonly handshakeTimeoutMs?: number;
    },
  ): Promise<CdpConnection> {
    this.#assertOpen(operation, resource);
    await this.retryPending();
    this.#assertOpen(operation, resource);
    if (options.signal?.aborted === true)
      throw new AnalysisCancelledError(operation, {
        cause: options.signal.reason,
      });
    this.#admissions += 1;
    let connection: CdpConnection | undefined;
    try {
      return await CdpConnection.connect(
        url,
        operation,
        options.signal,
        limits,
        (opened) => {
          connection = opened;
          this.register(opened, operation, resource);
        },
      );
    } catch (cause: unknown) {
      if (connection === undefined) throw cause;
      try {
        await this.finish(connection);
      } catch (cleanupCause: unknown) {
        if (
          cause instanceof AnalysisError &&
          cleanupCause instanceof AnalysisError
        )
          throw bindCdpTransportCleanup(
            cleanupCause,
            analysisErrorWithCleanupFailure(cause, cleanupCause, operation),
          );
        throw new AggregateError(
          [cause, cleanupCause],
          `CDP operation ${operation} failed during handshake and cleanup remains incomplete.`,
          { cause },
        );
      }
      throw cause;
    } finally {
      this.#admissions -= 1;
      if (this.#admissions === 0) {
        for (const resolve of this.#admissionWaiters) resolve();
        this.#admissionWaiters.clear();
      }
    }
  }

  /** Register synchronously before awaiting the WebSocket handshake. */
  register(
    connection: CdpConnection,
    operation: BrowserObservationOperation,
    resource: string,
  ): void {
    const root = transportRoot(connection);
    let settle = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#connections.set(root, {
      connection: root,
      operation,
      resource,
      cleanupLease: new AnalysisCleanupLease(() => root.close(), [resource]),
      active: true,
      activeLeases: 1,
      settled,
      settle,
      reusableUrl: undefined,
      evicted: false,
      closingTransport: false,
      statusUnsubscribe: undefined,
      cleanup: undefined,
      cleanupAttempted: false,
      failure: undefined,
    });
  }

  /** Finish one admitted operation, retaining a failed transport for retry. */
  async finish(
    connection: CdpConnection,
    cleanup?: () => Promise<void>,
  ): Promise<void> {
    const root = transportRoot(connection);
    const record = this.#connections.get(root);
    if (record === undefined) return;
    if (record.failure !== undefined) throw record.failure;
    this.#evictRecord(record);
    record.cleanup ??= cleanup;
    record.activeLeases = 0;
    try {
      if (!record.cleanupAttempted && record.cleanup !== undefined) {
        record.cleanupAttempted = true;
        await record.cleanup();
      }
      await this.#releaseTransportRecord(record);
    } catch (cause: unknown) {
      const failure =
        cause instanceof CdpTransportCleanupFailure
          ? cause
          : cleanupError(record, cause);
      record.failure = failure;
      throw failure;
    } finally {
      record.active = false;
      record.settle();
    }
  }

  /** Close retained browser sockets and retry failed transports after active peers finish. */
  async close(): Promise<void> {
    this.#closing = true;
    this.#browserSockets.clear();
    this.#closePromise ??= this.#closeAll().catch((cause: unknown) => {
      this.#closePromise = undefined;
      throw cause;
    });
    return await this.#closePromise;
  }

  /** Retry retained failures, including failed shared-socket closes with active peers. */
  async retryPending(): Promise<void> {
    const failures: CdpTransportCleanupFailure[] = [];
    for (const record of this.#connections.values()) {
      const needsRelease =
        !record.cleanupLease.released &&
        (record.failure !== undefined ||
          record.closingTransport ||
          (!record.active && record.evicted));
      if (!needsRelease) continue;
      try {
        await this.#releaseTransportRecord(record);
      } catch (cause: unknown) {
        if (cause instanceof CdpTransportCleanupFailure) failures.push(cause);
        else throw cause;
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw aggregateCleanupFailures(failures);
  }

  #assertOpen(operation: BrowserObservationOperation, resource: string): void {
    if (!this.#closing) return;
    throw new ProviderCleanupError(
      "rea-cdp-browser",
      [resource],
      { reason: "CDP provider is closing and cannot admit another session." },
      { operation },
    );
  }

  #evictRecord(record: OwnedConnection): void {
    record.evicted = true;
    if (
      record.reusableUrl !== undefined &&
      this.#browserSockets.get(record.reusableUrl) === record.connection
    )
      this.#browserSockets.delete(record.reusableUrl);
    record.statusUnsubscribe?.();
    record.statusUnsubscribe = undefined;
  }

  async #releaseTransportRecord(
    record: OwnedConnection,
    primaryCleanupCause?: unknown,
  ): Promise<void> {
    record.closingTransport = true;
    record.statusUnsubscribe?.();
    record.statusUnsubscribe = undefined;
    try {
      await record.cleanupLease.release();
      record.closingTransport = false;
      record.failure = undefined;
      if (record.activeLeases === 0)
        this.#connections.delete(record.connection);
    } catch (cause: unknown) {
      const combinedCause =
        primaryCleanupCause === undefined
          ? cause
          : new AggregateError(
              [primaryCleanupCause, cause],
              "Target cleanup and CDP transport close both failed.",
              { cause: primaryCleanupCause },
            );
      const failure = cleanupError(record, combinedCause);
      record.failure = failure;
      throw failure;
    }
  }

  async #closeAll(): Promise<void> {
    while (this.#admissions > 0)
      await new Promise<void>((resolve) => this.#admissionWaiters.add(resolve));
    while (true) {
      const active = [...this.#connections.values()].filter(
        ({ active }) => active,
      );
      if (active.length === 0) break;
      await Promise.all(active.map(({ settled }) => settled));
    }
    const failures: CdpTransportCleanupFailure[] = [];
    for (const record of this.#connections.values()) {
      this.#evictRecord(record);
      try {
        await this.#releaseTransportRecord(record);
      } catch (cause: unknown) {
        if (cause instanceof CdpTransportCleanupFailure) failures.push(cause);
        else throw cause;
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw aggregateCleanupFailures(failures);
  }
}

const transportRoot = (connection: CdpConnection): CdpConnection =>
  (connection as Partial<Pick<CdpConnection, "transportRoot">>).transportRoot ??
  connection;

const cleanupError = (
  record: OwnedConnection,
  cause: unknown,
): CdpTransportCleanupFailure =>
  new CdpTransportCleanupFailure([record.cleanupLease], {
    resources: [record.resource],
    operation: record.operation,
    cause,
    diagnostics: {
      reason:
        cause instanceof AnalysisError
          ? (cause.userMessage ?? cause.message)
          : cause instanceof Error
            ? cause.message
            : String(cause),
    },
  });

const aggregateCleanupFailures = (
  failures: readonly CdpTransportCleanupFailure[],
): CdpTransportCleanupFailure =>
  new CdpTransportCleanupFailure(
    failures.flatMap((failure) => failure.cleanupLeases),
    {
      resources: failures.flatMap(({ cleanupResources }) => cleanupResources),
      operation: "close_cdp_transports",
      cause: new AggregateError(
        failures,
        "One or more REA-owned CDP transports remain open.",
      ),
      diagnostics: {
        failures: failures.map(({ message, diagnostics }) => ({
          message,
          diagnostics: diagnostics ?? {},
        })),
      },
    },
  );
