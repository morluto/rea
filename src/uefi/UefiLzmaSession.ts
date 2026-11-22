import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { BinaryReader } from "../domain/binaryContainer.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import type { UefiOperation } from "../domain/uefi/uefiFirmwareAnalysis.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import {
  OwnedCommandFailure,
  ownedCommandResources,
  prepareOwnedCommand,
  throwCommandPreparationFailure,
} from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  type ProviderProcessSnapshot,
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import {
  processInspectionFailure,
  retainArtifactCommandCleanup,
  retainProcessInspectionCleanup,
} from "../providers/OwnedCommandCleanup.js";
import type { ProcessInspectionFailure } from "../process/ProcessInspectionCleanup.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  type ArtifactResourceScope,
} from "../resources/index.js";
import type { UefiDecodeFormat } from "./FfsSections.js";
import { uefiFailureDialect } from "./UefiFailures.js";
import type { UefiDecodeResult } from "./UefiImageScan.js";
import {
  encodeLzmaFrame,
  LZMA_FRAME_HEADER_BYTES,
  lzmaReplySchema,
} from "./UefiLzmaProtocol.js";
import { UEFI_PROVIDER_IDENTITY } from "./UefiProviderIdentity.js";

const workerAbortFailure = (
  signal: AbortSignal,
  snapshot: ProviderProcessSnapshot | null = null,
): unknown =>
  signal.reason instanceof AnalysisError
    ? signal.reason
    : new OwnedCommandFailure(
        "cancelled",
        "Command cancelled.",
        snapshot,
        null,
        {
          cancellation: { reason: signal.reason },
        },
      );

const throwIfWorkerAborted = (
  signal: AbortSignal,
  snapshot: ProviderProcessSnapshot | null = null,
): void => {
  if (signal.aborted) {
    throw workerAbortFailure(signal, snapshot);
  }
};

class ActiveWorkerReader {
  #chunks: Buffer[] = [];
  #chunkHead = 0;
  #buffered = 0;
  #ended = false;
  #error: Error | undefined;
  #waiter: (() => void) | undefined;

  constructor(
    private readonly stdout: Readable,
    private readonly supervisor: ProviderProcessSupervisor,
  ) {
    stdout.on("data", this.#onData);
    stdout.once("end", this.#onEnd);
    stdout.once("error", this.#onError);
  }

  readonly #onData = (chunk: Buffer): void => {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    this.#wake();
  };

  readonly #onEnd = (): void => {
    this.#ended = true;
    this.#wake();
  };

  readonly #onError = (cause: Error): void => {
    this.#error = cause;
    this.#wake();
  };

  #wake(): void {
    const wake = this.#waiter;
    this.#waiter = undefined;
    wake?.();
  }

  dispose(): void {
    this.stdout.off("data", this.#onData);
    this.stdout.off("end", this.#onEnd);
    this.stdout.off("error", this.#onError);
    this.#wake();
  }

  async readExact(length: number, signal: AbortSignal): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    while (this.#buffered < length) {
      throwIfWorkerAborted(signal, this.supervisor.snapshot());
      if (this.#error !== undefined) {
        throw new OwnedCommandFailure(
          "process",
          `LZMA worker stdout failed: ${this.#error.message}`,
          this.supervisor.snapshot(),
          null,
          { processError: this.#error },
        );
      }
      if (this.#ended || this.supervisor.observedExit() !== undefined) {
        const snap = this.supervisor.snapshot();
        const detail = snap.stderr.text.trim();
        throw new OwnedCommandFailure(
          "process",
          detail.length > 0
            ? `LZMA worker exited before completing reply: ${detail}`
            : "LZMA worker exited before completing reply.",
          snap,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.#waiter = undefined;
          reject(workerAbortFailure(signal, this.supervisor.snapshot()));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        this.#waiter = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    }
    const first = this.#chunks[this.#chunkHead]!;
    if (first.length === length) {
      this.#buffered -= length;
      this.#chunkHead += 1;
      if (this.#chunkHead >= this.#chunks.length) {
        this.#chunks.length = 0;
        this.#chunkHead = 0;
      } else if (
        this.#chunkHead >= 64 &&
        this.#chunkHead * 2 >= this.#chunks.length
      ) {
        this.#chunks.splice(0, this.#chunkHead);
        this.#chunkHead = 0;
      }
      return first;
    }
    const out = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length) {
      const head = this.#chunks[this.#chunkHead]!;
      const take = Math.min(head.length, length - copied);
      head.copy(out, copied, 0, take);
      copied += take;
      this.#buffered -= take;
      if (take === head.length) {
        this.#chunkHead += 1;
      } else {
        this.#chunks[this.#chunkHead] = head.subarray(take);
      }
    }
    if (this.#chunkHead >= this.#chunks.length) {
      this.#chunks.length = 0;
      this.#chunkHead = 0;
    } else if (
      this.#chunkHead >= 64 &&
      this.#chunkHead * 2 >= this.#chunks.length
    ) {
      this.#chunks.splice(0, this.#chunkHead);
      this.#chunkHead = 0;
    }
    return out;
  }
}

class ActiveWorkerStdin {
  #error: Error | undefined;

  constructor(
    private readonly stdin: Writable,
    private readonly supervisor: ProviderProcessSupervisor,
  ) {
    stdin.on("error", this.#onError);
  }

  readonly #onError = (cause: Error): void => {
    this.#error ??= cause;
  };

  end(): void {
    if (!this.stdin.destroyed && !this.stdin.writableEnded) {
      try {
        this.stdin.end();
      } catch {
        // Closing stdin is a cooperative EOF hint before supervisor.stop() enforces exit.
      }
    }
  }

  async writeFrame(frame: Buffer, signal: AbortSignal): Promise<void> {
    throwIfWorkerAborted(signal, this.supervisor.snapshot());
    if (this.#error !== undefined) {
      throw this.#processFailure(this.#error);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.stdin.off("error", onStreamError);
        this.stdin.off("close", onStreamClose);
        outcome();
      };
      const onAbort = (): void => {
        finish(() =>
          reject(workerAbortFailure(signal, this.supervisor.snapshot())),
        );
      };
      const onStreamError = (cause: Error): void => {
        finish(() => reject(this.#processFailure(cause)));
      };
      const onStreamClose = (): void => {
        const cause = this.#error;
        finish(() =>
          reject(
            cause !== undefined
              ? this.#processFailure(cause)
              : new OwnedCommandFailure(
                  "process",
                  "LZMA worker closed stdin before completing request write.",
                  this.supervisor.snapshot(),
                ),
          ),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.stdin.once("error", onStreamError);
      this.stdin.once("close", onStreamClose);
      this.stdin.write(frame, (err) => {
        if (err != null) {
          finish(() => reject(this.#processFailure(err)));
          return;
        }
        finish(() => resolve());
      });
    });
  }

  #processFailure(cause: Error): OwnedCommandFailure {
    return new OwnedCommandFailure(
      "process",
      `LZMA worker stdin failed: ${cause.message}`,
      this.supervisor.snapshot(),
      null,
      { processError: cause },
    );
  }
}

interface ActiveLzmaWorker {
  readonly root: PrivateRuntimeRoot;
  readonly rootLease: AnalysisCleanupLease;
  readonly workspace: {
    readonly kind: "lease";
    readonly resource: string;
    readonly lease: AnalysisCleanupLease;
  };
  supervisor: ProviderProcessSupervisor | undefined;
  readonly stdinWriter: ActiveWorkerStdin;
  readonly reader: ActiveWorkerReader;
  readonly resources: readonly string[];
}

/**
 * Per-scan bounded LZMA worker session. Spawns at most one isolated Node child
 * inside one `PrivateRuntimeRoot`, streams multiple compressed UEFI sections
 * over length-prefixed stdio frames, and stops the child before removing its
 * workspace root.
 */
export class UefiLzmaSession {
  #active: ActiveLzmaWorker | undefined;

  constructor(
    private readonly workerModulePath: string,
    private readonly operation: UefiOperation,
    private readonly resources: ArtifactResourceScope,
  ) {}

  async decode(
    payload: Buffer,
    format: Exclude<UefiDecodeFormat, "zlib">,
    maxOutputBytes: number,
    signal: AbortSignal,
  ): Promise<UefiDecodeResult> {
    throwIfWorkerAborted(signal);
    let active: ActiveLzmaWorker;
    try {
      active = await this.#ensureWorker(signal);
    } catch (cause: unknown) {
      const primary = classifyProviderFailure(
        cause,
        uefiFailureDialect(this.operation, this.workerModulePath),
      );
      const preparation = processInspectionFailure(cause);
      throw preparation === undefined
        ? primary
        : this.#retainInspectionCleanup(preparation, primary);
    }

    try {
      const requestHeader = JSON.stringify({
        format,
        max_output_bytes: maxOutputBytes,
      });
      await active.stdinWriter.writeFrame(
        encodeLzmaFrame(requestHeader, payload),
        signal,
      );
      const header = await active.reader.readExact(
        LZMA_FRAME_HEADER_BYTES,
        signal,
      );
      const headerReader = new BinaryReader(header, false, "LZMA-Frame");
      const replyBytes = headerReader.u32(0);
      const outputBytes = headerReader.u32(4);
      if (
        replyBytes === 0 ||
        replyBytes > UEFI_FIRMWARE_LIMITS.diagnosticBytes
      ) {
        await this.close();
        return {
          ok: false,
          reason: "decoder",
          message: "LZMA reply exceeds the diagnostic budget.",
        };
      }
      if (outputBytes > maxOutputBytes) {
        await this.close();
        return {
          ok: false,
          reason: "output-limit",
          message: `LZMA worker output (${outputBytes} bytes) exceeds ${maxOutputBytes} byte budget.`,
        };
      }
      const replyJsonBuf = await active.reader.readExact(replyBytes, signal);
      const decodedBytes = await active.reader.readExact(outputBytes, signal);
      const reply = lzmaReplySchema.parse(
        JSON.parse(replyJsonBuf.toString("utf8")),
      );
      if (!reply.ok) {
        return reply;
      }
      if (reply.input_bytes_consumed > payload.length) {
        return {
          ok: false,
          reason: "decoder",
          message: `LZMA worker reported consuming ${reply.input_bytes_consumed} bytes from a ${payload.length}-byte input.`,
        };
      }
      if (
        decodedBytes.length !== reply.output.bytes ||
        sha256Hex(decodedBytes) !== reply.output.sha256
      ) {
        return {
          ok: false,
          reason: "decoder",
          message: `LZMA worker output digest mismatch (${reply.output.sha256}).`,
        };
      }
      throwIfWorkerAborted(signal, active.supervisor?.snapshot() ?? null);
      return {
        ok: true,
        outcome: {
          bytes: decodedBytes,
          decoderVersion: reply.lzma_version,
          consumedBytes: reply.input_bytes_consumed,
        },
      };
    } catch (cause: unknown) {
      let primary = classifyProviderFailure(
        cause,
        uefiFailureDialect(this.operation, active.root.path),
      );
      const preparation = processInspectionFailure(cause);
      if (preparation !== undefined) {
        primary = this.#retainInspectionCleanup(preparation, primary);
      }
      await this.close(primary);
      throw primary;
    }
  }

  async close(primary?: AnalysisError): Promise<void> {
    const active = this.#active;
    if (active === undefined) return;
    this.#active = undefined;
    active.reader.dispose();
    active.stdinWriter.end();
    const released = await this.resources.release(active.workspace);
    if (released.kind === "failed") {
      const failure = new ProviderCleanupError(
        UEFI_PROVIDER_IDENTITY.id,
        active.rootLease.cleanupResources ?? [active.root.path],
        { reason: errorMessage(released.cause) },
        { cause: released.cause, operation: this.operation },
      );
      new AnalysisCleanupLeaseGroup(failure, [active.rootLease]);
      throw primary === undefined
        ? failure
        : analysisErrorWithCleanupDependencies(
            primary,
            failure,
            this.operation,
          );
    }
  }

  async #ensureWorker(signal: AbortSignal): Promise<ActiveLzmaWorker> {
    if (
      this.#active !== undefined &&
      this.#active.supervisor?.observedExit() === undefined
    ) {
      return this.#active;
    }
    if (this.#active !== undefined) {
      await this.close();
    }
    await prepareOwnedCommand(signal);
    const root = await PrivateRuntimeRoot.create({ prefix: "rea-uefi-lzma-" });
    let supervisor: ProviderProcessSupervisor | undefined;
    let processResources: readonly string[] = [];
    const rootLease = AnalysisCleanupLease.forCloseOwner(
      {
        async close() {
          if (supervisor !== undefined) {
            const stopped = await supervisor.stop();
            if (stopped.status === "incomplete") {
              throw new Error(stopped.reason);
            }
            supervisor.dispose();
            supervisor = undefined;
            processResources = [];
          }
          await root.close();
        },
        get cleanupResources() {
          return [...new Set([...processResources, root.path])];
        },
      },
      root.path,
    );
    const workspace = {
      kind: "lease",
      resource: root.path,
      lease: rootLease,
    } as const;

    try {
      const { NODE_OPTIONS: _ambientNodeOptions, ...environment } = process.env;
      let spawned: Awaited<ReturnType<typeof spawnOwnedProviderProcess>>;
      try {
        spawned = await spawnOwnedProviderProcess({
          command: process.execPath,
          arguments: [
            "--max-old-space-size=256",
            "--disable-wasm-trap-handler",
            this.workerModulePath,
            "--stdio",
          ],
          cwd: root.path,
          expectedCommand: null,
          runId: `rea-uefi-lzma-${randomUUID()}`,
          hostEnvironment: environment,
          stdin: "pipe",
          signal,
        });
      } catch (cause: unknown) {
        throwCommandPreparationFailure(
          cause,
          signal.aborted
            ? signal.reason instanceof AnalysisTimeoutError
              ? "timeout"
              : "cancelled"
            : undefined,
        );
      }
      processResources = ownedCommandResources(spawned.ownership, root.path);
      supervisor = new ProviderProcessSupervisor(
        {
          process: spawned.process,
          ownsProcessLifetime: true,
          ownership: spawned.ownership,
          ...(spawned.cleanup === undefined
            ? {}
            : { cleanup: spawned.cleanup }),
          ...(spawned.requestStop === undefined
            ? {}
            : { requestStop: spawned.requestStop }),
        },
        {
          captureStdout: false,
          maxDiagnosticBytes: UEFI_FIRMWARE_LIMITS.diagnosticBytes,
          runtime: "v8",
        },
      );
      const stdin = spawned.process.stdin;
      const stdout = spawned.process.stdout;
      if (stdin == null || stdout == null) {
        throw new Error("LZMA worker stdio pipes were not established.");
      }
      const stdinWriter = new ActiveWorkerStdin(stdin, supervisor);
      const reader = new ActiveWorkerReader(stdout, supervisor);
      const active: ActiveLzmaWorker = {
        root,
        rootLease,
        workspace,
        supervisor,
        stdinWriter,
        reader,
        resources: processResources,
      };
      this.#active = active;
      return active;
    } catch (cause: unknown) {
      let primary = classifyProviderFailure(
        cause,
        uefiFailureDialect(this.operation, root.path),
      );
      const preparation = processInspectionFailure(cause);
      if (preparation !== undefined) {
        primary = this.#retainInspectionCleanup(preparation, primary);
      }
      const released = await this.resources.release(workspace);
      if (released.kind === "failed") {
        const cleanup = new ProviderCleanupError(
          UEFI_PROVIDER_IDENTITY.id,
          rootLease.cleanupResources ?? [root.path],
          { reason: errorMessage(released.cause) },
          { cause: released.cause, operation: this.operation },
        );
        new AnalysisCleanupLeaseGroup(cleanup, [rootLease]);
        throw analysisErrorWithCleanupDependencies(
          primary,
          cleanup,
          this.operation,
        );
      }
      throw primary;
    }
  }

  #retainInspectionCleanup(
    preparation: ProcessInspectionFailure,
    primary: AnalysisError,
  ): AnalysisError {
    if (primary instanceof AnalysisTimeoutError) {
      if (
        preparation instanceof DarwinProcessOwnershipInspectionError &&
        preparation.capturedOutput !== undefined
      ) {
        primary.retainCapturedOutput(preparation.capturedOutput);
      }
      for (const failure of retainArtifactCommandCleanup(
        preparation,
        this.resources,
        this.operation,
      )) {
        primary = analysisErrorWithCleanupDependencies(
          primary,
          failure,
          this.operation,
        );
      }
      return primary;
    }
    return retainProcessInspectionCleanup(
      preparation,
      primary,
      this.resources,
      this.operation,
    );
  }
}
