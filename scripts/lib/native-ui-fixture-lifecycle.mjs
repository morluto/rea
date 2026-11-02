import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { cleanupOwnedProcessGroup } from "../../dist/process/ProcessOwnership.js";
import {
  observeProcessStartIdentity,
  systemProcessOwnershipHost,
} from "../../dist/process/ProcessOwnershipObservation.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../dist/process/ProviderProcess.js";
import {
  closeVerifierResources,
  withVerifierCleanup,
} from "./verifier-cleanup.mjs";

const READY_TIMEOUT_MS = 20_000;
const READY_POLL_INTERVAL_MS = 100;
const LAUNCHER_OUTPUT_CLOSE_GRACE_MS = 5_000;
const INTERRUPT_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

/** Cleanup stays incomplete; the owner keeps its run token and root for retry. */
export class NativeUiFixtureCleanupFailure extends Error {
  _tag = "NativeUiFixtureCleanupFailure";

  constructor(cleanupOwner, runId, options) {
    const failures =
      options.cause instanceof AggregateError
        ? options.cause.errors
        : [options.cause];
    super(
      `Native UI fixture cleanup is incomplete; retained ${cleanupOwner.root} for run ${runId}: ${failures.map((failure) => failure.message).join("; ")}`,
      options,
    );
    this.name = "NativeUiFixtureCleanupFailure";
    this.cleanupOwner = cleanupOwner;
    this.root = cleanupOwner.root;
    this.runId = runId;
  }
}

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

/** Parse the fixture's ready record once; only its selected fields leave here. */
const parseReadyRecord = (line) => {
  let record;
  try {
    record = JSON.parse(line);
  } catch (cause) {
    throw new Error("Source-owned UI fixture wrote a malformed ready record", {
      cause,
    });
  }
  if (!positiveInteger(record?.pid) || !positiveInteger(record?.window_id))
    throw new Error(
      `Source-owned UI fixture ready record lacks a selected PID and window: ${line}`,
    );
  return { pid: record.pid, window_id: record.window_id };
};

/**
 * Owns one LaunchServices fixture from before its launch through verified exit.
 *
 * `open` starts the app outside the launcher's process tree, so neither the
 * launcher handle nor a later PID report can establish ownership. The run token
 * placed in the launch environment can: the app carries it from its first
 * instruction, and the shared sweep finds it with or without a ready record.
 */
class NativeUiFixtureOwner {
  #runId = randomUUID();
  #lifetime = new AbortController();
  #launcherCommand;
  #readyTimeoutMs;
  #application;
  #launching;
  #launcher;
  #ownership;
  #familyReleased = false;
  #released = false;
  #closing;

  constructor(root, launcherCommand, readyTimeoutMs) {
    this.root = root;
    this.#launcherCommand = launcherCommand;
    this.#readyTimeoutMs = readyTimeoutMs;
  }

  /** Launch one fixture and return its token-verified ready scope. */
  launch(application) {
    if (this.#launching !== undefined)
      return Promise.reject(
        new Error("Native UI fixture owner launches one fixture"),
      );
    this.#launching = this.#launch(application);
    return this.#launching;
  }

  /** Release every owned resource; failure retains them for another close. */
  close() {
    this.#lifetime.abort(new Error("Native UI fixture owner closed"));
    if (this.#released) return Promise.resolve();
    this.#closing ??= this.#release().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  async #launch(application) {
    const { signal } = this.#lifetime;
    signal.throwIfAborted();
    this.#application = application;
    const coordinates = join(this.root, "scope.json");
    await writeFile(coordinates, "");
    const owned = await spawnOwnedProviderProcess({
      command: this.#launcherCommand,
      // open(1) gives the app its own environment, which already holds the token.
      // `--env` would add an argv entry the shared reader cannot prove, and a
      // readable launcher exposing one fails every concurrent sweep on this host.
      arguments: ["-W", "-n", "-g", "--stdout", coordinates, application],
      runId: this.#runId,
      sweepTokenOwnedProcesses: true,
      signal,
    });
    // Retain both authorities before the first handshake await.
    this.#ownership = owned.ownership;
    this.#launcher = new ProviderProcessSupervisor(
      { process: owned.process, ownsProcessLifetime: true },
      { maxDiagnosticBytes: { stdout: 0, stderr: 64 * 1024 } },
    );
    const scope = parseReadyRecord(await this.#awaitReady(coordinates, signal));
    const identity = await observeProcessStartIdentity(
      scope.pid,
      systemProcessOwnershipHost,
      this.#runId,
    );
    if (identity?.state !== "readable")
      throw new Error(
        `Source-owned UI fixture ready record names PID ${String(scope.pid)}, which does not prove this run: ${identity?.reason ?? "process is absent"}`,
      );
    return scope;
  }

  async #awaitReady(coordinates, signal) {
    const deadline = performance.now() + this.#readyTimeoutMs;
    for (;;) {
      signal.throwIfAborted();
      // Select exit first: a record written just before exit is still accepted.
      const exit = this.#launcher.observedExit();
      const output = await readFile(coordinates, "utf8");
      const end = output.indexOf("\n");
      if (end >= 0) return output.slice(0, end);
      if (exit !== undefined) {
        // Exit can precede the launcher's final diagnostics on its pipe.
        await this.#launcher.waitForOutputClose(LAUNCHER_OUTPUT_CLOSE_GRACE_MS);
        throw new Error(
          `Source-owned UI fixture launcher exited (code ${String(exit.code)}, signal ${String(exit.signal)}) before exposing one window: ${this.#launcher.snapshot().stderr.text.trim() || "no launcher diagnostics"}`,
        );
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new Error(
          `Source-owned UI fixture failed to expose one window within ${String(this.#readyTimeoutMs / 1000)} seconds`,
        );
      // An abort rejects with a generic error; the loop reports its own reason.
      await delay(Math.min(READY_POLL_INTERVAL_MS, remaining), undefined, {
        signal,
      }).catch(() => undefined);
    }
  }

  async #release() {
    // Join acquisition: a launcher created before the abort stays owned here.
    await this.#launching?.catch(() => undefined);
    try {
      // Attempt each: a stuck launcher must not spare a token-proven fixture.
      await closeVerifierResources([
        () => this.#stopLauncher(),
        () => this.#retireApplication(),
        () => this.#sweepFixture(),
      ]);
      await rm(this.root, { recursive: true, force: true });
    } catch (cause) {
      throw new NativeUiFixtureCleanupFailure(this, this.#runId, { cause });
    }
    this.#released = true;
  }

  /**
   * /usr/bin/open is a platform binary, so macOS withholds its token and the
   * sweep cannot prove it. Its retained child handle is the authority instead,
   * and the launcher must be gone before the sweep can succeed.
   */
  async #stopLauncher() {
    if (this.#launcher === undefined) return;
    const stopped = await this.#launcher.stop();
    if (stopped.status === "incomplete")
      throw new Error(`Native UI fixture launcher: ${stopped.reason}`);
  }

  /**
   * LaunchServices finishes a launch after `open` dies: on macOS 26 arm64 the
   * app appeared after an immediate sweep when `open` was killed 10-20 ms after
   * spawn. Retire the path it must exec, so the sweep that follows is not racing
   * a launch that can still start.
   */
  async #retireApplication() {
    if (this.#launcher === undefined) return;
    try {
      await rename(this.#application, `${this.#application}.retired`);
    } catch (cause) {
      // Already retired by an earlier attempt, or never created.
      if (cause.code !== "ENOENT") throw cause;
    }
  }

  async #sweepFixture() {
    if (this.#ownership === undefined || this.#familyReleased) return;
    const result = await cleanupOwnedProcessGroup(this.#ownership);
    if (!result.cleaned)
      throw new Error(`Native UI fixture processes: ${result.reason}`, {
        cause: result,
      });
    this.#familyReleased = true;
  }
}

/** Allocate one private fixture root and the owner that alone may remove it. */
export const createNativeUiFixtureOwner = async ({
  launcherCommand = "/usr/bin/open",
  readyTimeoutMs = READY_TIMEOUT_MS,
} = {}) =>
  new NativeUiFixtureOwner(
    await mkdtemp(join(tmpdir(), "rea-ui-fixture-")),
    launcherCommand,
    readyTimeoutMs,
  );

/**
 * Run one lane around a fixture owner and settle its process outcome in one place.
 *
 * A signal only records the interruption and ends the operation's race. The
 * release always runs to settlement, and every signal stays handled until then:
 * npm forwards Ctrl-C, so a default action on a repeated signal would kill the
 * release and orphan the fixture. SIGKILL remains the operator's override.
 *
 * The first failure selects the status and every failure is reported. A signal
 * after the operation failed keeps that failure and exit 1; a signal after it
 * succeeded returns its completed value with the interrupted exit status.
 */
export const runNativeUiFixtureLane = async (operation, options) => {
  const fixture = await createNativeUiFixtureOwner(options);
  let interruption;
  let operationFailure;
  let interrupt;
  const interrupted = new Promise((_, reject) => {
    interrupt = reject;
  });
  interrupted.catch(() => undefined);
  const listeners = Object.entries(INTERRUPT_EXIT_CODES).map(
    ([signal, exitCode]) => {
      const listener = () => {
        if (interruption !== undefined) return;
        interruption = Object.assign(
          new Error(`Native UI verification interrupted by ${signal}`),
          { exitCode },
        );
        interrupt(interruption);
      };
      process.on(signal, listener);
      return [signal, listener];
    },
  );
  try {
    const value = await withVerifierCleanup(
      () =>
        Promise.race([operation(fixture), interrupted]).catch((cause) => {
          operationFailure = cause;
          throw cause;
        }),
      [() => fixture.close()],
    );
    if (interruption !== undefined) process.exitCode = interruption.exitCode;
    return value;
  } catch (cause) {
    if (
      interruption === undefined ||
      (operationFailure !== undefined && operationFailure !== interruption)
    )
      throw cause;
    console.error(cause === interruption ? cause.message : cause);
    // An interrupted operation may still be running; nothing else ends it.
    process.exit(interruption.exitCode);
  } finally {
    for (const [signal, listener] of listeners) process.off(signal, listener);
  }
};
