import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

import type {
  OwnedProcessGroup,
  ProcessCleanupResult,
} from "./ProcessOwnership.js";

const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_KILL_GRACE_MS = 1_000;

/** Spawn coordinates shared by owned, long-lived provider processes. */
export interface OwnedProviderProcessSpawnOptions {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly runId: string;
  /** Null disables argv-prefix matching for interpreter-driven launch scripts. */
  readonly expectedCommand?: string | null;
  /** Preserve a pre-quoted Windows command-interpreter invocation exactly. */
  readonly windowsVerbatimArguments?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Spawned process paired with the identity proof required for group cleanup. */
export interface SpawnedOwnedProviderProcess {
  readonly process: ChildProcess;
  readonly ownership: OwnedProcessGroup;
}

/** Process handle returned by a provider-specific launcher. */
export interface ProviderProcessLaunch {
  readonly process: ChildProcess;
  readonly ownsProcessLifetime: boolean;
  readonly cleanup?: () => Promise<ProcessCleanupResult>;
}

/** Detached diagnostics captured for one supervised provider process. */
export interface ProviderProcessSnapshot {
  readonly stdout: {
    readonly text: string;
    readonly bytes: number;
    readonly retainedBytes: number;
    readonly truncated: boolean;
  };
  readonly stderr: {
    readonly text: string;
    readonly bytes: number;
    readonly retainedBytes: number;
    readonly truncated: boolean;
  };
  readonly exitCode: number | null | undefined;
  readonly signal: NodeJS.Signals | null | undefined;
}

/** Resource-safe events emitted without imposing provider protocol semantics. */
export type ProviderProcessDiagnostic =
  | {
      readonly type: "output";
      readonly stream: "stdout" | "stderr";
      readonly bytes: number;
      readonly totalBytes: number;
      readonly truncated: boolean;
    }
  | {
      readonly type: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly snapshot: ProviderProcessSnapshot;
    }
  | { readonly type: "error"; readonly message: string };

/** Options for bounded capture and lifecycle diagnostics. */
export interface ProviderProcessSupervisorOptions {
  readonly maxOutputBytesPerStream?: number;
  readonly onDiagnostic?: (event: ProviderProcessDiagnostic) => void;
}

/** Optional result of provider-specific cleanup performed before stop. */
export interface ProviderProcessStopOptions {
  readonly cleanupResult?: ProcessCleanupResult;
  readonly terminationGraceMs?: number;
  readonly killGraceMs?: number;
}

/** Exact disposition of one owned process stop attempt. */
export type ProviderProcessStopResult =
  | {
      readonly status:
        | "not-owned"
        | "already-exited"
        | "verified-cleanup"
        | "terminated"
        | "killed";
    }
  | { readonly status: "incomplete"; readonly reason: string };

/**
 * Spawn a provider in a dedicated POSIX process group with an ownership token.
 *
 * The caller remains responsible for persisting any ownership manifest and for
 * selecting provider-specific command arguments or environment values.
 */
export const spawnOwnedProviderProcess = async (
  options: OwnedProviderProcessSpawnOptions,
): Promise<SpawnedOwnedProviderProcess> => {
  const child = spawn(options.command, [...options.arguments], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
    env: {
      ...process.env,
      ...options.env,
      REA_PROCESS_RUN_ID: options.runId,
    },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  await waitForSpawn(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("Provider launcher has no process ID");
  const ownership: OwnedProcessGroup = {
    runId: options.runId,
    leaderPid: pid,
    processGroupId: pid,
    expectedParentPid: process.pid,
    ...(options.expectedCommand === null
      ? {}
      : { expectedCommand: options.expectedCommand ?? options.command }),
  };
  return { process: child, ownership };
};

/**
 * Supervises only generic process resources; wire protocol remains adapter-owned.
 *
 * Output retention is bounded per stream while byte totals remain exact. Stop
 * first honors token-verified group cleanup when supplied, otherwise it uses a
 * bounded TERM-to-KILL escalation for a directly owned child.
 */
export class ProviderProcessSupervisor {
  readonly #options: ProviderProcessSupervisorOptions;
  readonly #stdout: BoundedByteCapture;
  readonly #stderr: BoundedByteCapture;
  readonly #exit = deferred<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>();
  readonly #onStdout = (chunk: Buffer | string): void => {
    this.#capture("stdout", this.#stdout, chunk);
  };
  readonly #onStderr = (chunk: Buffer | string): void => {
    this.#capture("stderr", this.#stderr, chunk);
  };
  readonly #onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.#recordExit(code, signal);
  };
  readonly #onClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.#recordExit(code, signal);
  };
  readonly #onError = (cause: Error): void => {
    this.#options.onDiagnostic?.({ type: "error", message: cause.message });
  };
  #exitObservation:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;
  #stopPromise: Promise<ProviderProcessStopResult> | undefined;
  #disposed = false;

  constructor(
    readonly launch: ProviderProcessLaunch,
    options: ProviderProcessSupervisorOptions = {},
  ) {
    this.#options = options;
    const limit = options.maxOutputBytesPerStream ?? DEFAULT_OUTPUT_BYTES;
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new RangeError("Provider output limit must be a positive integer");
    this.#stdout = new BoundedByteCapture(limit);
    this.#stderr = new BoundedByteCapture(limit);
    this.#attach(launch.process.stdout, "stdout");
    this.#attach(launch.process.stderr, "stderr");
    launch.process.once("exit", this.#onExit);
    launch.process.once("close", this.#onClose);
    launch.process.on("error", this.#onError);
    if (launch.process.exitCode !== null || launch.process.signalCode !== null)
      this.#recordExit(launch.process.exitCode, launch.process.signalCode);
  }

  /** Latest bounded output and exit observation. */
  snapshot(): ProviderProcessSnapshot {
    return {
      stdout: this.#stdout.snapshot(),
      stderr: this.#stderr.snapshot(),
      exitCode: this.#exitObservation?.code,
      signal: this.#exitObservation?.signal,
    };
  }

  /** Wait for process exit up to a caller-owned bounded interval. */
  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exitObservation !== undefined) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#exit.promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Stop an owned process once; concurrent callers share the same escalation. */
  stop(
    options: ProviderProcessStopOptions = {},
  ): Promise<ProviderProcessStopResult> {
    this.#stopPromise ??= this.#stop(options);
    return this.#stopPromise;
  }

  /** Detach capture and process listeners after an adapter releases ownership. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.launch.process.stdout?.off("data", this.#onStdout);
    this.launch.process.stderr?.off("data", this.#onStderr);
    this.launch.process.off("exit", this.#onExit);
    this.launch.process.off("close", this.#onClose);
    this.launch.process.off("error", this.#onError);
  }

  async #stop(
    options: ProviderProcessStopOptions,
  ): Promise<ProviderProcessStopResult> {
    try {
      if (!this.launch.ownsProcessLifetime) return { status: "not-owned" };
      if (this.launch.cleanup !== undefined) {
        const cleanup = await this.#ownedCleanup(options.cleanupResult);
        if (!cleanup.cleaned)
          return { status: "incomplete", reason: cleanup.reason };
        const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
        if (await this.waitForExit(graceMs))
          return { status: "verified-cleanup" };
        const retried = await this.launch.cleanup();
        if (!retried.cleaned)
          return { status: "incomplete", reason: retried.reason };
        if (await this.waitForExit(graceMs))
          return { status: "verified-cleanup" };
        return {
          status: "incomplete",
          reason: "verified process-group cleanup did not stop the launcher",
        };
      }

      if (this.#exitObservation !== undefined)
        return { status: "already-exited" };

      this.#signal("SIGTERM");
      if (
        await this.waitForExit(
          options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
        )
      )
        return { status: "terminated" };
      this.#signal("SIGKILL");
      if (await this.waitForExit(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS))
        return { status: "killed" };
      return {
        status: "incomplete",
        reason: "owned provider process did not exit after SIGKILL",
      };
    } catch (cause: unknown) {
      return {
        status: "incomplete",
        reason:
          cause instanceof Error
            ? cause.message
            : "owned provider process cleanup failed",
      };
    } finally {
      this.dispose();
    }
  }

  #ownedCleanup(
    supplied: ProcessCleanupResult | undefined,
  ): Promise<ProcessCleanupResult> {
    if (supplied !== undefined) return Promise.resolve(supplied);
    const cleanup = this.launch.cleanup;
    return cleanup === undefined
      ? Promise.resolve({
          cleaned: false,
          reason: "owned provider process has no cleanup capability",
        })
      : cleanup();
  }

  #signal(signal: NodeJS.Signals): void {
    if (this.#exitObservation !== undefined) return;
    this.launch.process.kill(signal);
  }

  #attach(stream: Readable | null, name: "stdout" | "stderr"): void {
    if (name === "stdout") stream?.on("data", this.#onStdout);
    else stream?.on("data", this.#onStderr);
  }

  #capture(
    stream: "stdout" | "stderr",
    capture: BoundedByteCapture,
    chunk: Buffer | string,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    capture.append(bytes);
    this.#options.onDiagnostic?.({
      type: "output",
      stream,
      bytes: bytes.byteLength,
      totalBytes: capture.bytes,
      truncated: capture.truncated,
    });
  }

  #recordExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exitObservation !== undefined) return;
    this.#exitObservation = { code, signal };
    this.#exit.resolve(this.#exitObservation);
    this.#options.onDiagnostic?.({
      type: "exit",
      code,
      signal,
      snapshot: this.snapshot(),
    });
  }
}

class BoundedByteCapture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #retainedBytes = 0;

  constructor(readonly limit: number) {}

  get bytes(): number {
    return this.#bytes;
  }

  get truncated(): boolean {
    return this.#bytes > this.#retainedBytes;
  }

  append(chunk: Buffer): void {
    this.#bytes += chunk.byteLength;
    const remaining = this.limit - this.#retainedBytes;
    if (remaining <= 0) return;
    const retained = Buffer.from(chunk.subarray(0, remaining));
    this.#chunks.push(retained);
    this.#retainedBytes += retained.byteLength;
  }

  snapshot(): ProviderProcessSnapshot["stdout"] {
    return {
      text: Buffer.concat(this.#chunks, this.#retainedBytes).toString("utf8"),
      bytes: this.#bytes,
      retainedBytes: this.#retainedBytes,
      truncated: this.truncated,
    };
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolver: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolver?.(value);
    },
  };
};

const waitForSpawn = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (cause: Error): void => {
      child.off("spawn", onSpawn);
      reject(cause);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
