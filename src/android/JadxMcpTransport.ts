import {
  deserializeMessage,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import type {
  OwnedProviderProcessSpawnOptions,
  SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_OPERATION_BYTES = 32 * 1024 * 1024;

/** Injectable process acquisition seam; the production launcher owns a POSIX group. */
export type JadxLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** SDK-framed stdio with REA-owned process cleanup rather than an unowned child. */
export class JadxMcpTransport implements Transport {
  onclose: Transport["onclose"];
  onerror: Transport["onerror"];
  onmessage: Transport["onmessage"];
  readonly runId = randomUUID();
  #spawned: SpawnedOwnedProviderProcess | undefined;
  #supervisor: ProviderProcessSupervisor | undefined;
  #frameBuffer = Buffer.alloc(0);
  #frameLength = 0;
  #bytes = 0;
  #started = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #failure: string | null = null;

  constructor(
    readonly options: Omit<OwnedProviderProcessSpawnOptions, "runId" | "stdin">,
    readonly launcher: JadxLauncher = spawnOwnedProviderProcess,
  ) {}

  /** Acquires exactly one protocol process after the SDK installs callbacks. */
  start(): Promise<void> {
    if (this.#started || this.#closed)
      throw new Error("JADX transport cannot be restarted");
    this.#started = true;
    this.#starting = this.#acquire();
    return this.#starting;
  }

  async #acquire(): Promise<void> {
    const spawned = await this.launcher({
      ...this.options,
      runId: this.runId,
      stdin: "pipe",
    });
    this.#spawned = spawned;
    this.#supervisor = new ProviderProcessSupervisor({
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    }, { captureStdout: false });
    if (
      spawned.process.stdin === undefined ||
      spawned.process.stdin === null ||
      spawned.process.stdout === null
    )
      throw new Error("JADX launcher did not supply protocol stdin/stdout");
    spawned.process.stdout.on("data", this.#read);
    spawned.process.stderr?.on("data", this.#countStderr);
    spawned.process.on("error", this.#error);
    spawned.process.once("exit", this.#exit);
    spawned.process.stdin.on("error", this.#error);
    if (this.#closed) throw new Error("JADX transport closed during startup");
  }

  /** Writes SDK-serialized messages and observes stream backpressure. */
  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.#spawned?.process.stdin;
    if (this.#closed || input === undefined || input === null)
      throw new Error("JADX protocol process is not writable");
    await new Promise<void>((resolve, reject) => {
      input.write(serializeMessage(message), (cause) =>
        cause === null || cause === undefined ? resolve() : reject(cause),
      );
    });
  }

  /** Verifies owned process exit before declaring the transport closed. */
  close(): Promise<void> {
    this.#closePromise ??= this.#stop();
    return this.#closePromise;
  }

  /** Captured provider stderr without persisting inherited environment values. */
  diagnostics(): string {
    return this.#supervisor?.snapshot().stderr.text ?? "";
  }

  /** Preserve the failed protocol/resource constraint after the SDK closes requests. */
  failureReason(): string | null {
    return this.#failure;
  }

  /** Scope both the byte budget and diagnostic retention to the next serialized request. */
  beginOperation(): void {
    this.#bytes = 0;
    this.#supervisor?.resetOutput();
  }

  async #stop(): Promise<void> {
    this.#closed = true;
    this.#frameBuffer = Buffer.alloc(0);
    this.#frameLength = 0;
    // A cancellation may race acquisition. Join it before inspecting ownership.
    await this.#starting?.catch(() => undefined);
    const process = this.#spawned?.process;
    process?.stdout?.off("data", this.#read);
    process?.stderr?.off("data", this.#countStderr);
    process?.off("error", this.#error);
    process?.off("exit", this.#exit);
    process?.stdin?.off("error", this.#error);
    const stopped = await this.#supervisor?.stop();
    this.onclose?.();
    if (stopped?.status === "incomplete")
      throw new ProviderCleanupError("jadx", [this.runId], {
        reason: stopped.reason,
        stderr: this.diagnostics(),
      });
  }

  readonly #error = (error: Error): void => {
    this.onerror?.(error);
  };
  readonly #exit = (): void => {
    this.onclose?.();
  };
  readonly #countStderr = (chunk: Buffer | string): void => {
    this.#bytes += Buffer.byteLength(chunk);
    if (this.#bytes > MAX_OPERATION_BYTES)
      this.#fail(
        new Error(
          `JADX operation output exceeds ${MAX_OPERATION_BYTES} bytes; no complete result is available`,
        ),
      );
  };
  readonly #read = (chunk: Buffer | string): void => {
    if (this.#closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#bytes += bytes.length;
    if (this.#bytes > MAX_OPERATION_BYTES) {
      this.#fail(
        new Error(
          `JADX operation output exceeds ${MAX_OPERATION_BYTES} bytes; no complete result is available`,
        ),
      );
      return;
    }
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const end = newline === -1 ? bytes.length : newline;
        const fragment = bytes.subarray(offset, end);
        const frameBytes = this.#frameLength + fragment.length;
        if (frameBytes > MAX_FRAME_BYTES)
          throw new Error(`JADX MCP frame exceeds ${MAX_FRAME_BYTES} bytes`);
        this.#appendFrame(fragment, frameBytes);
        if (newline === -1) return;
        const line = this.#frameBuffer
          .subarray(0, this.#frameLength)
          .toString("utf8");
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
        MAX_FRAME_BYTES,
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
    this.#failure ??= error.message;
    this.onerror?.(error);
    // Closing immediately rejects the SDK's outstanding request. The owner
    // awaits close again and retains a cleanup failure in the returned Result.
    void this.close().catch((cause: unknown) =>
      this.onerror?.(cause instanceof Error ? cause : new Error(String(cause))),
    );
  }
}
