import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

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
  readonly signalCode: NodeJS.Signals | null = null;
  exitCode: number | null = null;
  readonly pid: number;
  readonly #handle: object;
  readonly #authority: WindowsNativeAuthority;
  readonly #settled: Promise<void>;
  #settle: (() => void) | undefined;
  #closed = false;
  #verifiedSettlement = false;
  #failure: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #cleanup: Promise<ProcessCleanupResult> | undefined;

  constructor(
    command: string,
    arguments_: readonly string[],
    cwd: string | undefined,
    environment: NodeJS.ProcessEnv,
    verbatim: boolean,
  ) {
    super();
    this.#authority = requireWindowsNativeAuthority();
    const entries = Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`);
    const line = [
      quoteWindowsProcessArgument(command),
      ...arguments_.map((value) =>
        verbatim ? value : quoteWindowsProcessArgument(value),
      ),
    ].join(" ");
    const launched = launchSchema.parse(
      this.#authority.call("process_spawn", [
        command,
        line,
        cwd ?? "",
        entries,
      ]),
    );
    this.pid = launched.pid;
    this.#handle = launched.handle;
    this.#settled = new Promise((resolve) => {
      this.#settle = resolve;
    });
    this.#schedule();
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
    this.#cleanup ??= this.#stop();
    return this.#cleanup;
  }

  async #stop(): Promise<ProcessCleanupResult> {
    if (this.#closed)
      return this.#verifiedSettlement
        ? { cleaned: true, signaled: false }
        : {
            cleaned: false,
            reason:
              this.#failure ?? "Windows Job Object settlement was not verified",
          };
    let timer: NodeJS.Timeout | undefined;
    try {
      const signaled = this.kill();
      const settled = await Promise.race([
        this.#settled.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000);
        }),
      ]);
      return settled && this.#verifiedSettlement
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
      if (!this.#closed) this.#release();
    }
  }

  #schedule(): void {
    this.#timer = setTimeout(() => this.#poll(), 25);
  }

  #poll(): void {
    if (this.#closed) return;
    try {
      const state = pollSchema.parse(
        this.#authority.call("process_poll", [this.#handle]),
      );
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
        this.#verifiedSettlement = true;
        this.#release();
      } else this.#schedule();
    } catch (cause: unknown) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      this.#failure = failure.message;
      // Native lifecycle failures belong to the error/cleanup channels, never
      // the captured stderr observation produced by the child itself.
      if (this.listenerCount("error") > 0) this.emit("error", failure);
      this.#release();
    }
  }

  #release(): void {
    if (this.#closed) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#authority.call("process_close", [this.#handle]);
    this.#closed = true;
    this.stdout.end();
    this.stderr.end();
    this.#settle?.();
    this.emit("close", this.exitCode, null);
  }
}
