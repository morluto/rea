import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { z } from "zod";

import type { ProcessCleanupResult } from "../process/ProcessOwnership.js";
import {
  requireWindowsNativeAuthority,
  windowsHandleSchema,
  type WindowsNativeAuthority,
} from "./WindowsNativeLoader.js";

const launchSchema = z.strictObject({
  pid: z.number().int().positive().max(0xffff_ffff),
  handle: windowsHandleSchema,
  jobAssigned: z.literal(true),
  killOnOwnerClose: z.literal(true),
});
const pollSchema = z.strictObject({
  stdout: z.instanceof(Buffer),
  stderr: z.instanceof(Buffer),
  stdoutEnded: z.boolean(),
  stderrEnded: z.boolean(),
  exitCode: z.number().int().nonnegative().max(0xffff_ffff).nullable(),
  activeProcesses: z.number().int().nonnegative(),
});
// A commit-limited job reports its applied limit at launch and its
// notification state on every poll; an unlimited job reports neither.
const limitedPollSchema = pollSchema.extend({
  memoryLimitReached: z.boolean(),
  peakJobMemoryBytes: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
});

/** Optional native job controls for one owned Windows process tree. */
export interface WindowsOwnedProcessOptions {
  /** Open a writable protocol pipe; otherwise stdin is NUL. */
  readonly protocolStdin?: boolean;
  /** Job Object commit limit for the whole process tree, in bytes. */
  readonly memoryLimitBytes?: number;
  /** Verified native authority; defaults to the package-owned artifact. */
  readonly authority?: WindowsNativeAuthority;
}

/** Encode one ordinary Windows argv token using the CRT backslash rules. */
export const quoteWindowsProcessArgument = (value: string): string => {
  if (value.includes("\0"))
    throw new TypeError("Windows process argument contains NUL");
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
};

/** Process events and streams backed by a retained native Job Object. */
export class WindowsOwnedProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable | null;
  readonly signalCode: NodeJS.Signals | null = null;
  exitCode: number | null = null;
  readonly pid: number;
  readonly #handle: object;
  readonly #authority: WindowsNativeAuthority;
  readonly #settled: Promise<void>;
  #settle: (() => void) | undefined;
  #closed = false;
  #failure: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #unreferenced = false;
  #cleanup: Promise<ProcessCleanupResult> | undefined;
  readonly #memoryLimitBytes: number | undefined;
  #memoryLimitReached = false;
  #peakJobMemoryBytes: number | undefined;

  constructor(
    command: string,
    arguments_: readonly string[],
    cwd: string | undefined,
    environment: NodeJS.ProcessEnv,
    verbatim: boolean,
    options: WindowsOwnedProcessOptions = {},
  ) {
    super();
    const protocolStdin = options.protocolStdin === true;
    this.#memoryLimitBytes = options.memoryLimitBytes;
    this.#authority = options.authority ?? requireWindowsNativeAuthority();
    if (protocolStdin && this.#authority.inspection.protocolStdin !== true)
      throw new Error(
        "The bundled Windows native artifact does not support owned protocol stdin; use a matching current Windows x64 REA package.",
      );
    // A requested limit is never dropped: an artifact without the control
    // refuses the launch instead of starting an unlimited process.
    if (
      this.#memoryLimitBytes !== undefined &&
      this.#authority.inspection.jobMemoryLimit !== true
    )
      throw new Error(
        "The bundled Windows native artifact does not support Job Object memory limits; use a matching current Windows x64 REA package.",
      );
    const entries = Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`);
    const line = [
      // cmd.exe parses its own command line rather than the CRT argv rules;
      // its executable token must match the native drive-path representation.
      quoteWindowsProcessArgument(command.replaceAll("/", "\\")),
      ...arguments_.map((value) =>
        verbatim ? value : quoteWindowsProcessArgument(value),
      ),
    ].join(" ");
    // Earlier artifacts accept only 4 or 5 arguments; keep that shape unless
    // a commit limit is requested.
    let controls: unknown[] = protocolStdin ? [true] : [];
    if (this.#memoryLimitBytes !== undefined)
      controls = [protocolStdin, this.#memoryLimitBytes];
    const spawned = this.#authority.call("process_spawn", [
      command,
      line,
      cwd ?? "",
      entries,
      ...controls,
    ]);
    const launched =
      this.#memoryLimitBytes === undefined
        ? launchSchema.parse(spawned)
        : launchSchema
            .extend({ jobMemoryLimitBytes: z.literal(this.#memoryLimitBytes) })
            .parse(spawned);
    this.pid = launched.pid;
    this.#handle = launched.handle;
    this.stdin = protocolStdin
      ? new Writable({
          write: (chunk: unknown, _encoding, callback) => {
            void this.#writeInput(chunk).then(
              () => callback(),
              (cause: unknown) =>
                callback(
                  cause instanceof Error ? cause : new Error(String(cause)),
                ),
            );
          },
          final: (callback) => {
            try {
              this.#authority.call("process_stdin_close", [this.#handle]);
              callback();
            } catch (cause: unknown) {
              callback(
                cause instanceof Error ? cause : new Error(String(cause)),
              );
            }
          },
          destroy: (cause, callback) => {
            try {
              if (!this.#closed)
                this.#authority.call("process_stdin_close", [this.#handle]);
              callback(cause);
            } catch (failure: unknown) {
              callback(
                failure instanceof Error ? failure : new Error(String(failure)),
              );
            }
          },
        })
      : null;
    this.#settled = new Promise((resolve) => {
      this.#settle = resolve;
    });
    this.#schedule();
  }

  /** Whether the job reported reaching its commit limit; sticky once observed. */
  get memoryLimitReached(): boolean {
    return this.#memoryLimitReached;
  }

  /** Latest observed peak job commit; undefined for an unlimited job. */
  get peakJobMemoryBytes(): number | undefined {
    return this.#peakJobMemoryBytes;
  }

  async #writeInput(chunk: unknown): Promise<void> {
    const bytes = z.instanceof(Buffer).parse(chunk);
    const written = z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(
        await this.#authority.call("process_stdin_write", [
          this.#handle,
          bytes,
        ]),
      );
    if (written !== bytes.length)
      throw new Error(
        "Owned Windows input write did not preserve all requested bytes",
      );
  }

  /** Terminate the retained job, never a PID supplied by another caller. */
  kill(signal?: NodeJS.Signals | number): boolean {
    if (signal === 0)
      return (
        !this.#closed &&
        z
          .number()
          .parse(this.#authority.call("process_alive", [this.#handle])) > 0
      );
    return this.#closed
      ? false
      : z
          .boolean()
          .parse(this.#authority.call("process_terminate", [this.#handle]));
  }

  /** Terminate and verify that the entire job has settled before releasing it. */
  cleanup(): Promise<ProcessCleanupResult> {
    this.#cleanup ??= this.#stop().then((result) => {
      if (!result.cleaned) this.#cleanup = undefined;
      return result;
    });
    return this.#cleanup;
  }

  /** Release event-loop references so unsettled jobs do not prevent host exit. */
  unref(): void {
    this.#unreferenced = true;
    this.#timer?.unref();
  }

  /** Restore event-loop references when retrying process lifecycle observation. */
  ref(): void {
    this.#unreferenced = false;
    this.#timer?.ref();
  }

  async #stop(): Promise<ProcessCleanupResult> {
    if (this.#closed) return { cleaned: true, signaled: false };
    let timer: NodeJS.Timeout | undefined;
    try {
      const signaled = this.kill();
      this.#schedule();
      const settled = await Promise.race([
        this.#settled.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000);
        }),
      ]);
      return settled
        ? { cleaned: true, signaled }
        : {
            cleaned: false,
            reason:
              this.#failure ??
              "Windows Job Object did not settle within the cleanup deadline",
          };
    } catch (cause: unknown) {
      return {
        cleaned: false,
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #schedule(): void {
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => this.#poll(), 25);
    if (this.#unreferenced) this.#timer.unref();
  }

  #poll(): void {
    this.#timer = undefined;
    if (this.#closed) return;
    try {
      const observed: unknown = this.#authority.call("process_poll", [
        this.#handle,
      ]);
      let state: z.output<typeof pollSchema>;
      if (this.#memoryLimitBytes === undefined)
        state = pollSchema.parse(observed);
      else {
        const limited = limitedPollSchema.parse(observed);
        // Recorded before exit is emitted, so exit listeners observe it.
        this.#memoryLimitReached ||= limited.memoryLimitReached;
        this.#peakJobMemoryBytes = limited.peakJobMemoryBytes;
        state = limited;
      }
      this.#failure = undefined;
      if (state.stdout.length > 0) this.stdout.write(state.stdout);
      if (state.stderr.length > 0) this.stderr.write(state.stderr);
      if (state.exitCode !== null && this.exitCode === null) {
        this.exitCode = state.exitCode;
        this.emit("exit", state.exitCode, null);
      }
      if (
        state.exitCode !== null &&
        state.stdoutEnded &&
        state.stderrEnded &&
        state.activeProcesses === 0
      ) {
        this.#release();
      } else this.#schedule();
    } catch (cause: unknown) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      this.#failure = failure.message;
      // Native lifecycle failures belong to the error/cleanup channels, never
      // the captured stderr observation produced by the child itself.
      if (this.listenerCount("error") > 0) this.emit("error", failure);
      // Retain the original job so explicit cleanup can retry its observation.
    }
  }

  #release(): void {
    if (this.#closed) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#authority.call("process_close", [this.#handle]);
    this.#closed = true;
    this.stdin?.destroy();
    this.stdout.end();
    this.stderr.end();
    this.#settle?.();
    this.emit("close", this.exitCode, null);
  }
}
