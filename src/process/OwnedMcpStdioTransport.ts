import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { OwnerCancellation } from "../domain/analysisErrorCore.js";
import {
  deserializeMessage,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import type {
  OwnedProviderProcessSpawnOptions,
  ProcessDiagnosticBudget,
  SpawnedOwnedProviderProcess,
} from "./ProviderProcess.js";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import { Budget } from "../domain/budget.js";
import type { FixedAllowance } from "../domain/fixedAllowanceRemediation.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "./ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "./ProcessOwnership.js";
import { DarwinProcessOwnershipInspectionError } from "./DarwinProcessRunTokenReader.js";
import {
  processInspectionCleanupFailures,
  type ProcessInspectionCleanupFailure,
} from "./ProcessInspectionCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../resources/index.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Injectable acquisition seam; production owns a POSIX group or Windows job. */
export type OwnedMcpLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** The first observed failure, recorded before notifying the SDK or beginning cleanup. */
export type OwnedMcpTransportFailure =
  | { readonly kind: "process"; readonly cause: unknown }
  | { readonly kind: "exit" }
  | { readonly kind: "protocol"; readonly cause: Error }
  | {
      /**
       * The protocol process exceeded a fixed frame or per-operation byte
       * ceiling; the adapter attributes the refusal to its operation.
       */
      readonly kind: "output_limit";
      readonly scope: "frame" | "operation";
      readonly ceiling: FixedAllowance & { readonly limit: number };
      readonly cause: Error;
    }
  | { readonly kind: "interrupted"; readonly reason: unknown };

/** SDK-framed stdio with REA-owned process cleanup rather than an unowned child. */
export class OwnedMcpStdioTransport implements Transport {
  onclose: Transport["onclose"];
  onerror: Transport["onerror"];
  onmessage: Transport["onmessage"];
  readonly runId = randomUUID();
  #spawned: SpawnedOwnedProviderProcess | undefined;
  #supervisor: ProviderProcessSupervisor | undefined;
  #frameBuffer = Buffer.alloc(0);
  #frameLength = 0;
  /** Output charged to the current operation; stays over once it is exceeded. */
  readonly #bytes: Budget | undefined;
  #started = false;
  #closed = false;
  readonly #cleanup = new AnalysisCleanupLease(
    () => this.#stop(),
    [this.runId],
  );
  #starting: Promise<void> | undefined;
  #preparations:
    | readonly {
        readonly failure: ProcessInspectionCleanupFailure;
        readonly resource: string;
        readonly lease: AnalysisCleanupLease;
      }[]
    | undefined;
  /** Ends a launch still resolving or spawning when the transport closes. */
  readonly #acquisition = new AbortController();
  #failure: OwnedMcpTransportFailure | undefined;

  constructor(
    readonly options: Omit<OwnedProviderProcessSpawnOptions, "runId" | "stdin">,
    readonly settings: {
      readonly provider: string;
      /** Operation named by cleanup failures; provider sessions keep close_binary. */
      readonly operation?: string;
      readonly label: string;
      readonly maxFrameBytes: number;
      /** Bytes one serialized operation may produce; omit when only frames are bounded. */
      readonly maxOperationBytes?: number;
      readonly gracefulInputCloseMs?: number;
      readonly maxDiagnosticBytes?: ProcessDiagnosticBudget;
      /** Observe the owned child's stderr from acquisition onward, including when it closes early. */
      readonly onStderr?: (chunk: unknown) => void;
      /** Owner-redacted output attached to cleanup failures when the owner retains its own tail. */
      readonly capturedOutput?: () => AnalysisCapturedOutput;
      readonly notifyOnExit?: boolean;
    },
    readonly launcher: OwnedMcpLauncher = spawnOwnedProviderProcess,
  ) {
    if (settings.maxOperationBytes !== undefined)
      this.#bytes = new Budget(settings.maxOperationBytes);
  }

  /** Acquires exactly one protocol process after the SDK installs callbacks. */
  start(): Promise<void> {
    if (this.#started || this.#closed)
      throw new Error(`${this.settings.label} transport cannot be restarted`);
    this.#started = true;
    this.#starting = this.#acquire().catch((cause: unknown) => {
      this.#failure ??= { kind: "process", cause };
      throw cause;
    });
    return this.#starting;
  }

  async #acquire(): Promise<void> {
    const spawned = await this.launcher({
      ...this.options,
      runId: this.runId,
      stdin: "pipe",
      signal:
        this.options.signal === undefined
          ? this.#acquisition.signal
          : AbortSignal.any([this.options.signal, this.#acquisition.signal]),
    });
    this.#spawned = spawned;
    this.#supervisor = new ProviderProcessSupervisor(
      {
        ...spawned,
        ownsProcessLifetime: true,
        cleanup:
          spawned.cleanup ??
          (() => cleanupOwnedProcessGroup(spawned.ownership)),
      },
      {
        captureStdout: false,
        ...(this.settings.maxDiagnosticBytes === undefined
          ? {}
          : { maxDiagnosticBytes: this.settings.maxDiagnosticBytes }),
      },
    );
    if (
      spawned.process.stdin === undefined ||
      spawned.process.stdin === null ||
      spawned.process.stdout === null
    )
      throw new Error(
        `${this.settings.label} launcher did not supply protocol stdin/stdout`,
      );
    spawned.process.stdout.on("data", this.#read);
    spawned.process.stdout.on("error", this.#error);
    spawned.process.stderr?.on("data", this.#countStderr);
    if (this.settings.onStderr !== undefined)
      spawned.process.stderr?.on("data", this.settings.onStderr);
    spawned.process.on("error", this.#error);
    spawned.process.once("exit", this.#exit);
    spawned.process.once("close", this.#outputClosed);
    spawned.process.stdin.on("error", this.#error);
    if (this.#closed)
      throw new Error(`${this.settings.label} transport closed during startup`);
  }

  /** Writes SDK-serialized messages and observes stream backpressure. */
  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.#spawned?.process.stdin;
    if (this.#closed || input === undefined || input === null)
      throw new Error(
        `${this.settings.label} protocol process is not writable`,
      );
    await new Promise<void>((resolve, reject) => {
      try {
        input.write(serializeMessage(message), (cause) => {
          if (cause === null || cause === undefined) resolve();
          else {
            this.#failure ??= { kind: "process", cause };
            reject(cause);
          }
        });
      } catch (cause) {
        this.#failure ??= { kind: "process", cause };
        reject(cause);
      }
    });
  }

  /** Verifies owned process exit before declaring the transport closed. */
  close(): Promise<void> {
    this.#closed = true;
    return this.#cleanup.release();
  }

  /** Keep the interruption reason distinct from errors produced by its teardown. */
  interrupt(reason: unknown): Promise<void> {
    this.#failure ??= { kind: "interrupted", reason };
    return this.close();
  }

  /** Captured provider stderr without persisting inherited environment values. */
  diagnostics(): AnalysisCapturedOutput | undefined {
    const owner = this.#supervisor;
    if (owner === undefined) return undefined;
    const snapshot = owner.snapshot();
    return {
      stdout: "",
      stderr: snapshot.stderr.text,
      stderr_bytes: snapshot.stderr.observedBytes,
      truncated:
        snapshot.diagnosticTruncated === true || !owner.observedOutputClose(),
      ...(snapshot.exitCode === undefined
        ? {}
        : { exit_code: snapshot.exitCode }),
      ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
    };
  }

  /** Preserve the failed protocol/resource constraint after the SDK closes requests. */
  observedFailure(): OwnedMcpTransportFailure | undefined {
    return this.#failure;
  }

  /**
   * Stop the retained process from holding the host's event loop after its
   * cleanup failed; a later close restores the references for the retry.
   */
  detach(): void {
    this.#supervisor?.unref();
  }

  /** Scope both the byte budget and diagnostic retention to the next serialized request. */
  beginOperation(): void {
    this.#bytes?.restore(0);
    this.#supervisor?.resetOutput();
  }

  async #stop(): Promise<void> {
    this.#frameBuffer = Buffer.alloc(0);
    this.#frameLength = 0;
    // A cancellation may race acquisition: end a launch that is still
    // resolving its command, then join it before inspecting ownership.
    this.#acquisition.abort(OwnerCancellation.ownerClosed);
    // A failed launch may transfer ownership-preparation cleanup (a helper
    // directory or file handle it could not remove); this close owns it.
    const startFailure = await this.#starting?.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    const process = this.#spawned?.process;
    process?.stdout?.off("data", this.#read);
    process?.stdout?.off("error", this.#error);
    process?.stderr?.off("data", this.#countStderr);
    process?.off("error", this.#error);
    process?.off("exit", this.#exit);
    process?.off("close", this.#outputClosed);
    const input = process?.stdin;
    // A job termination can complete an in-flight pipe write asynchronously.
    // Observe its errors until the owned Writable has finished closing.
    const inputClosed =
      input === undefined || input === null
        ? undefined
        : finished(input, { readable: false, cleanup: true }).catch(
            () => undefined,
          );
    const gracefulInputCloseMs = this.settings.gracefulInputCloseMs ?? 0;
    if (input !== undefined && input !== null && gracefulInputCloseMs > 0) {
      input.end();
      await this.#supervisor?.waitForExit(gracefulInputCloseMs);
    }
    const stopped = await this.#supervisor?.stop();
    input?.destroy();
    await inputClosed;
    input?.off("error", this.#error);
    // Detach the stderr observer only after bounded cleanup and draining have
    // settled, so shutdown diagnostics still reach the caller's report.
    if (this.settings.onStderr !== undefined)
      process?.stderr?.off("data", this.settings.onStderr);
    this.onclose?.();
    if (stopped?.status === "incomplete") {
      const failure = new ProviderCleanupError(
        this.settings.provider,
        [this.runId],
        {
          reason: stopped.reason,
          stderr: this.diagnostics()?.stderr ?? "",
        },
        {
          ...(this.settings.operation === undefined
            ? {}
            : { operation: this.settings.operation }),
          ...(this.settings.capturedOutput === undefined
            ? {}
            : { capturedOutput: this.settings.capturedOutput() }),
        },
      );
      new AnalysisCleanupLeaseGroup(failure, [this.#cleanup]);
      throw failure;
    }
    await this.#releasePreparations(startFailure);
  }

  /** A refused close retains its lease while independent owners still get a turn. */
  async #releasePreparations(startFailure: unknown): Promise<void> {
    this.#preparations ??= processInspectionCleanupFailures(startFailure).map(
      (failure) => {
        const darwin = failure instanceof DarwinProcessOwnershipInspectionError;
        const owner = darwin ? failure.cleanupOwner : failure.owner;
        const resource = darwin ? "process ownership inspection" : failure.path;
        return {
          failure,
          resource,
          lease: new AnalysisCleanupLease(async () => {
            if (owner === undefined) throw failure;
            await owner.close();
          }, [resource]),
        };
      },
    );
    const pending = [];
    for (const preparation of this.#preparations) {
      try {
        await preparation.lease.release();
      } catch (cause: unknown) {
        pending.push({ ...preparation, reason: errorMessage(cause) });
      }
    }
    const first = pending[0];
    if (first === undefined) return;
    const failure = new ProviderCleanupError(
      this.settings.provider,
      pending.map(({ resource }) => resource),
      {
        reason:
          pending.length === 1
            ? first.reason
            : pending
                .map(({ resource, reason }) => `${resource}: ${reason}`)
                .join("\n"),
      },
      {
        cause: pending.length === 1 ? first.failure : startFailure,
        ...(this.settings.operation === undefined
          ? {}
          : { operation: this.settings.operation }),
      },
    );
    new AnalysisCleanupLeaseGroup(
      failure,
      pending.map(({ lease }) => lease),
    );
    throw failure;
  }

  readonly #error = (error: Error): void => {
    this.#failure ??= { kind: "process", cause: error };
    this.onerror?.(error);
    // Reject pending SDK work after joining the same owned teardown on every path.
    void this.close().catch((cause: unknown) =>
      this.onerror?.(cause instanceof Error ? cause : new Error(String(cause))),
    );
  };
  readonly #exit = (): void => {
    this.#failure ??= { kind: "exit" };
    if (this.settings.notifyOnExit === true) this.onclose?.();
  };
  readonly #outputClosed = (): void => {
    if (this.settings.notifyOnExit !== true) this.onclose?.();
  };
  readonly #countStderr = (chunk: Buffer | string): void => {
    this.#countOperationBytes(Buffer.byteLength(chunk));
  };
  /** Charge output to the operation budget; false once it is exceeded. */
  #countOperationBytes(bytes: number): boolean {
    const budget = this.#bytes;
    if (budget === undefined) return true;
    budget.chargeOverCommitting(bytes);
    if (budget.overCommitted === 0) return true;
    const limit = budget.maximum;
    this.#failLimit(
      "operation",
      limit,
      `${this.settings.label} operation output exceeds ${limit} bytes; no complete result is available`,
    );
    return false;
  }
  readonly #read = (chunk: Buffer | string): void => {
    if (this.#closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.#countOperationBytes(bytes.length)) return;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const end = newline === -1 ? bytes.length : newline;
        const fragment = bytes.subarray(offset, end);
        const frameBytes = this.#frameLength + fragment.length;
        if (frameBytes > this.settings.maxFrameBytes) {
          this.#failLimit(
            "frame",
            this.settings.maxFrameBytes,
            `${this.settings.label} MCP frame exceeds ${this.settings.maxFrameBytes} bytes`,
          );
          return;
        }
        if (this.#frameLength === 0 && newline !== -1) {
          // Preserve a leading BOM so the JSON-RPC parser can reject it.
          const line = decodeStrictUtf8(fragment, "preserve");
          this.onmessage?.(deserializeMessage(line));
          offset = newline + 1;
          continue;
        }
        if (this.#frameLength === 0 && newline !== -1) {
          // Fast path: complete line in a single chunk needs no scratch buffer copy.
          const line = decodeStrictUtf8(fragment, "preserve");
          this.onmessage?.(deserializeMessage(line));
          offset = newline + 1;
          continue;
        }
        this.#appendFrame(fragment, frameBytes);
        if (newline === -1) return;
        // Preserve a leading BOM so the JSON-RPC parser can reject it.
        const line = decodeStrictUtf8(
          this.#frameBuffer.subarray(0, this.#frameLength),
          "preserve",
        );
        this.#frameBuffer = Buffer.alloc(0);
        this.#frameLength = 0;
        this.onmessage?.(deserializeMessage(line));
        offset = newline + 1;
      }
    } catch (cause) {
      this.#fail(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };
  #appendFrame(fragment: Buffer, frameBytes: number): void {
    if (frameBytes > this.#frameBuffer.length) {
      const capacity = Math.min(
        this.settings.maxFrameBytes,
        Math.max(frameBytes, this.#frameBuffer.length * 2, 1),
      );
      const grown = Buffer.allocUnsafe(capacity);
      this.#frameBuffer.copy(grown, 0, 0, this.#frameLength);
      this.#frameBuffer = grown;
    }
    fragment.copy(this.#frameBuffer, this.#frameLength);
    this.#frameLength = frameBytes;
  }
  #fail(error: Error): void {
    this.#failure ??= { kind: "protocol", cause: error };
    this.#error(error);
  }
  /** Record a fixed output ceiling the process exceeded, then fail the session. */
  #failLimit(
    scope: "frame" | "operation",
    limit: number,
    message: string,
  ): void {
    const cause = new Error(message);
    this.#failure ??= {
      kind: "output_limit",
      scope,
      ceiling: {
        name: `The ${this.settings.label} ${scope === "frame" ? "frame" : "operation output"} allowance of ${String(limit)} bytes`,
        kind: "bytes",
        limit,
        unit: "bytes",
      },
      cause,
    };
    this.#error(cause);
  }
}
