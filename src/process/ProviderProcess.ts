import { spawn, type ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

import { WindowsOwnedProcess } from "../windows/WindowsOwnedProcess.js";

import type {
  OwnedProcessGroup,
  ProcessCleanupResult,
} from "./ProcessOwnership.js";
import { prepareProcessOwnershipInspection } from "./ProcessOwnershipObservation.js";

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
  /** Host platform used to choose detached process-group behavior. */
  readonly platform?: NodeJS.Platform;
  /** Host environment used as the base for the child environment. */
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  /** Opt into a writable protocol stream; other providers retain ignored stdin. */
  readonly stdin?: "pipe";
}

/** Spawned process paired with the identity proof required for group cleanup. */
export interface SpawnedOwnedProviderProcess {
  readonly process: ProviderProcessHandle;
  readonly ownership: OwnedProcessGroup;
  readonly cleanup?: () => Promise<ProcessCleanupResult>;
}

/** Process events and streams required by provider lifecycle supervision. */
export interface ProviderProcessHandle extends Pick<
  EventEmitter,
  "on" | "once" | "off"
> {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stdin?: Writable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Process handle returned by a provider-specific launcher. */
export type ProviderProcessLaunch =
  | {
      readonly process: ProviderProcessHandle;
      readonly ownsProcessLifetime: false;
      readonly ownership?: never;
      readonly cleanup?: never;
    }
  | {
      readonly process: ProviderProcessHandle;
      readonly ownsProcessLifetime: true;
      readonly ownership?: OwnedProcessGroup;
      readonly cleanup?: () => Promise<ProcessCleanupResult>;
    };

/** Detached diagnostics captured for one supervised provider process. */
export interface ProviderProcessSnapshot {
  readonly stdout: {
    readonly text: string;
    readonly bytes: number;
  };
  readonly stderr: {
    readonly text: string;
    readonly bytes: number;
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
    }
  | {
      readonly type: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly snapshot: ProviderProcessSnapshot;
    }
  | { readonly type: "error"; readonly message: string };

/** Options for process lifecycle diagnostics. */
export interface ProviderProcessSupervisorOptions {
  /** Retain stdout for diagnostics; disable when it carries a parsed protocol. Defaults to true. */
  readonly captureStdout?: boolean;
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
 * Spawn a provider in an owned Windows job or dedicated POSIX process group.
 *
 * The caller remains responsible for persisting any ownership manifest and for
 * selecting provider-specific command arguments or environment values.
 */
export const spawnOwnedProviderProcess = async (
  options: OwnedProviderProcessSpawnOptions,
): Promise<SpawnedOwnedProviderProcess> => {
  await prepareProcessOwnershipInspection();
  const platform = options.platform ?? process.platform;
  const hostEnvironment = options.hostEnvironment ?? process.env;
  const environment = {
    ...hostEnvironment,
    ...options.env,
    REA_PROCESS_RUN_ID: options.runId,
  };
  if (platform === "win32" && process.platform === "win32") {
    if (options.stdin === "pipe")
      throw new Error(
        "Owned Windows provider processes do not support protocol stdin",
      );
    const child = new WindowsOwnedProcess(
      options.command,
      options.arguments,
      options.cwd,
      environment,
      options.windowsVerbatimArguments ?? false,
    );
    return {
      process: child,
      ownership: {
        runId: options.runId,
        leaderPid: child.pid,
        processGroupId: child.pid,
        expectedParentPid: process.pid,
      },
      cleanup: () => child.cleanup(),
    };
  }
  const child = spawn(options.command, [...options.arguments], {
    shell: false,
    windowsHide: true,
    stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
    detached: platform !== "win32",
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
    env: environment,
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
 * Output retention is complete per stream; adapters own resource budgets. Stop
 * first honors token-verified group cleanup when supplied, otherwise it uses a
 * bounded TERM-to-KILL escalation for a directly owned child.
 */
export class ProviderProcessSupervisor {
  readonly #options: ProviderProcessSupervisorOptions;
  readonly #stdout = new ProcessOutputCapture();
  readonly #stderr = new ProcessOutputCapture();
  readonly #exit = deferred<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>();
  readonly #outputClose = deferred<void>();
  #outputClosed = false;
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
    this.#outputClosed = true;
    this.#outputClose.resolve(undefined);
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
    if (options.captureStdout !== false)
      this.#attach(launch.process.stdout, "stdout");
    this.#attach(launch.process.stderr, "stderr");
    launch.process.once("exit", this.#onExit);
    launch.process.once("close", this.#onClose);
    launch.process.on("error", this.#onError);
    if (launch.process.exitCode !== null || launch.process.signalCode !== null)
      this.#recordExit(launch.process.exitCode, launch.process.signalCode);
  }

  /** Latest complete output and exit observation. */
  snapshot(): ProviderProcessSnapshot {
    return {
      stdout: this.#stdout.snapshot(),
      stderr: this.#stderr.snapshot(),
      exitCode: this.#exitObservation?.code,
      signal: this.#exitObservation?.signal,
    };
  }

  /** Begin a new observation on a retained process without retaining earlier output. */
  resetOutput(): void {
    this.#stdout.reset();
    this.#stderr.reset();
  }

  /** Wait for process exit up to a caller-owned bounded interval. */
  async waitForExit(timeoutMs: number): Promise<boolean> {
    return waitForProcessEvent(
      this.#exitObservation !== undefined,
      this.#exit.promise,
      timeoutMs,
    );
  }

  /** Wait until the producer has closed its output streams; exit alone does not prove complete output. */
  async waitForOutputClose(timeoutMs: number): Promise<boolean> {
    return waitForProcessEvent(
      this.#outputClosed,
      this.#outputClose.promise,
      timeoutMs,
    );
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
    capture: ProcessOutputCapture,
    chunk: Buffer | string,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    capture.append(bytes);
    this.#options.onDiagnostic?.({
      type: "output",
      stream,
      bytes: bytes.byteLength,
      totalBytes: capture.bytes,
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

class ProcessOutputCapture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;

  get bytes(): number {
    return this.#bytes;
  }

  reset(): void {
    this.#chunks.length = 0;
    this.#bytes = 0;
  }

  append(chunk: Buffer): void {
    this.#bytes += chunk.byteLength;
    this.#chunks.push(Buffer.from(chunk));
  }

  snapshot(): ProviderProcessSnapshot["stdout"] {
    const text = Buffer.concat(this.#chunks, this.#bytes).toString("utf8");
    return {
      text,
      bytes: this.#bytes,
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

const waitForProcessEvent = async (
  observed: boolean,
  event: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> => {
  if (observed) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      event.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
