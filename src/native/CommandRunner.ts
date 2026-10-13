import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";

import { err, ok, type Result } from "../domain/result.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type {
  OwnedProviderProcessSpawnOptions,
  ProviderProcessSnapshot,
  ProviderProcessSupervisor,
  SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { boundedUtf8Text } from "../process/boundedUtf8Text.js";

/** Maximum wall-clock duration for one native command. */
export const NATIVE_COMMAND_TIMEOUT_MS = 60_000;
/** Retain complete command output up to a bounded aggregate size. */
export const NATIVE_COMMAND_OUTPUT_BUDGET_BYTES = 64 * 1024 * 1024;
/**
 * Failure diagnostics keep only an excerpt of each stream. Successful
 * analysis needs complete output, but a failed command's error would
 * otherwise repeat up to the whole output budget to the caller.
 */
export const NATIVE_FAILURE_DIAGNOSTIC_BYTES = 64 * 1024;

export interface NativeCommandCapture {
  readonly tool: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly toolVersion: string | null;
  readonly versionReason: string | null;
  readonly arguments: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** Native command failure with retained partial output and cleanup status. */
export class NativeCommandFailure extends Error {
  readonly cleanupOwner: ProviderProcessSupervisor | undefined;
  readonly cleanupFailures: readonly NativeCommandCleanupFailure[];
  readonly detail: string | null;

  constructor(
    readonly tool: string,
    readonly reason:
      | "unavailable"
      | "cancelled"
      | "timeout"
      | "output-limit"
      | "nonzero-exit"
      | "io",
    readonly exitCode: number | null = null,
    options?: NativeCommandFailureOptions,
    readonly capture: NativeCommandFailureCapture | null = null,
    readonly cleanupFailure: string | null = null,
    readonly cleanupResources: readonly string[] = [],
  ) {
    super(`Native command ${tool} failed: ${reason}`, options);
    this.cleanupOwner = options?.cleanupOwner;
    this.cleanupFailures = options?.cleanupFailures ?? [];
    this.detail = options?.detail ?? null;
  }
}

/** Named cleanup ownership carried alongside the ordinary error cause. */
export interface NativeCommandFailureOptions extends ErrorOptions {
  /** Typed owner retained when command process cleanup was incomplete. */
  readonly cleanupOwner?: ProviderProcessSupervisor;
  /** All owners still incomplete after a preflight retry blocked this command. */
  readonly cleanupFailures?: readonly NativeCommandCleanupFailure[];
  /** Host-side reason the command could not be supervised, such as a missing ownership helper compiler. */
  readonly detail?: string;
}

/** One failed cleanup attempt; the runner retains `owner` until it is verified stopped. */
export interface NativeCommandCleanupFailure {
  readonly owner: ProviderProcessSupervisor;
  readonly reason: string;
  readonly resources: readonly string[];
}

/** Partial output and lifecycle details retained when a native command fails. */
export interface NativeCommandFailureCapture {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly truncated: boolean;
}

/** Cancellation and exit handling for one allowlisted native command. */
export interface NativeCommandOptions {
  readonly signal?: AbortSignal;
  readonly acceptNonZero?: boolean;
}

export interface NativeCommandRunner {
  run(
    tool: string,
    arguments_: readonly string[],
    options: NativeCommandOptions,
  ): Promise<Result<NativeCommandCapture, NativeCommandFailure>>;
  /** Retry only owners from completed commands whose cleanup was incomplete. */
  retryCleanup?(): Promise<readonly NativeCommandCleanupFailure[]>;
}

/** Optional launch seam for production-boundary lifecycle verification. */
export type NativeCommandLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** Resolve one allowlisted native tool to an immutable executable identity. */
export type NativeToolResolver = (
  tool: string,
  signal?: AbortSignal,
  launcher?: NativeCommandLauncher,
) => Promise<Result<ResolvedTool, NativeCommandFailure>>;

/** Run allowlisted Xcode tools directly without a shell. */
export class XcrunCommandRunner implements NativeCommandRunner {
  private readonly environment: NodeJS.ProcessEnv;
  readonly #pendingCleanup = new Set<ProviderProcessSupervisor>();
  #cleanupAttempt: Promise<readonly NativeCommandCleanupFailure[]> | undefined;
  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly resolveTool: NativeToolResolver = (tool, signal) =>
      resolveXcrunTool(tool, this.environment, signal, this.launcher),
    private readonly launcher?: NativeCommandLauncher,
  ) {
    this.environment = snapshotEnvironment(environment);
  }

  run(
    tool: string,
    arguments_: readonly string[],
    options: NativeCommandOptions,
  ): Promise<Result<NativeCommandCapture, NativeCommandFailure>> {
    if (!ALLOWED_TOOLS.has(tool))
      return Promise.resolve(
        err(new NativeCommandFailure(tool, "unavailable")),
      );
    return this.#runAfterCleanup(tool, arguments_, options);
  }

  /** Retry every retained owner; a failed retry prevents another command launch. */
  retryCleanup(): Promise<readonly NativeCommandCleanupFailure[]> {
    if (this.#pendingCleanup.size === 0) return Promise.resolve([]);
    if (this.#cleanupAttempt !== undefined) return this.#cleanupAttempt;
    this.#cleanupAttempt = this.#retryCleanup().finally(() => {
      this.#cleanupAttempt = undefined;
    });
    return this.#cleanupAttempt;
  }

  async #runAfterCleanup(
    tool: string,
    arguments_: readonly string[],
    options: NativeCommandOptions,
  ): Promise<Result<NativeCommandCapture, NativeCommandFailure>> {
    const pendingFailures = await this.retryCleanup();
    if (pendingFailures.length > 0)
      return err(commandCleanupFailure(tool, pendingFailures));
    const resolved = await this.resolveTool(
      tool,
      options.signal,
      this.launcher,
    );
    if (!resolved.ok) {
      if (resolved.error.cleanupOwner !== undefined)
        this.#pendingCleanup.add(resolved.error.cleanupOwner);
      return resolved;
    }
    const captured = await captureProcess(
      resolved.value.path,
      arguments_,
      tool,
      options,
      this.environment,
      this.launcher,
    );
    if (!captured.ok && captured.error.cleanupOwner !== undefined)
      this.#pendingCleanup.add(captured.error.cleanupOwner);
    return captured.ok
      ? ok({
          ...captured.value,
          tool,
          executable: resolved.value.path,
          executableSha256: resolved.value.sha256,
          toolVersion: null,
          versionReason:
            "Tool exposes no uniform stable version flag; executable SHA-256 is a prelaunch file sample and does not prove atomic OS image binding.",
          arguments: [...arguments_],
        })
      : captured;
  }

  async #retryCleanup(): Promise<readonly NativeCommandCleanupFailure[]> {
    const failures: NativeCommandCleanupFailure[] = [];
    for (const owner of this.#pendingCleanup) {
      let reason: string | undefined;
      try {
        const stopped = await owner.stop();
        if (stopped.status !== "incomplete") {
          this.#pendingCleanup.delete(owner);
          continue;
        }
        reason = stopped.reason || "native command cleanup remains unverified";
      } catch (cause: unknown) {
        reason =
          cause instanceof Error
            ? cause.message || cause.name
            : String(cause) || "native command cleanup failed unexpectedly";
      }
      failures.push({
        owner,
        reason: reason ?? "native command cleanup remains unverified",
        resources: commandProcessResources(owner),
      });
    }
    return failures;
  }
}

const commandProcessResources = (
  owner: ProviderProcessSupervisor,
): readonly string[] => {
  const ownership = owner.launch.ownership;
  return ownership === undefined
    ? ["native-command-process"]
    : [
        ownership.runId,
        `pid:${String(ownership.leaderPid)}`,
        `process-group:${String(ownership.processGroupId)}`,
      ];
};

const commandCleanupFailure = (
  tool: string,
  failures: readonly NativeCommandCleanupFailure[],
): NativeCommandFailure =>
  new NativeCommandFailure(
    tool,
    "io",
    null,
    {
      cleanupFailures: failures,
      cause: new AggregateError(
        failures.map(
          ({ reason, resources }) =>
            new Error(`${reason} (${resources.join(", ")})`),
        ),
        "Previously owned native command cleanup remains incomplete",
      ),
    },
    null,
    failures
      .map(({ reason, resources }) => `${resources.join(", ")}: ${reason}`)
      .join("; "),
    [...new Set(failures.flatMap(({ resources }) => resources))],
  );

/** Executable path and SHA-256 sampled during one tool resolution. */
export interface ResolvedTool {
  readonly path: string;
  readonly sha256: string;
}

const ALLOWED_TOOLS = new Set([
  "codesign",
  "dyld_info",
  "dwarfdump",
  "file",
  "lipo",
  "nm",
  "otool",
  "plutil",
  "strings",
  "swift-demangle",
  "vtool",
]);

/** Locate an Xcode tool through `xcrun --find` and sample its executable digest. */
export const resolveXcrunTool = async (
  tool: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  signal?: AbortSignal,
  launcher?: NativeCommandLauncher,
): Promise<Result<ResolvedTool, NativeCommandFailure>> => {
  const found = await captureProcess(
    "/usr/bin/xcrun",
    ["--find", tool],
    "xcrun",
    signal === undefined ? {} : { signal },
    environment,
    launcher,
  );
  if (!found.ok) {
    return err(
      new NativeCommandFailure(
        tool,
        found.error.reason === "nonzero-exit" ||
          found.error.reason === "unavailable"
          ? "unavailable"
          : found.error.reason,
        found.error.exitCode,
        {
          cause: found.error,
          ...(found.error.cleanupOwner === undefined
            ? {}
            : { cleanupOwner: found.error.cleanupOwner }),
          ...(found.error.cleanupFailures.length === 0
            ? {}
            : { cleanupFailures: found.error.cleanupFailures }),
          ...(found.error.detail === null
            ? {}
            : { detail: found.error.detail }),
        },
        found.error.capture,
        found.error.cleanupFailure,
        found.error.cleanupResources,
      ),
    );
  }
  if (found.value.exitCode !== 0)
    return err(
      new NativeCommandFailure(
        tool,
        "unavailable",
        found.value.exitCode,
        undefined,
        failureCapture(found.value, false),
      ),
    );
  const candidate = found.value.stdout.trim();
  if (!candidate.startsWith("/"))
    return err(
      new NativeCommandFailure(
        tool,
        "unavailable",
        found.value.exitCode,
        undefined,
        failureCapture(found.value, false),
      ),
    );
  try {
    const path = await realpath(candidate);
    return ok({ path, sha256: await hashFile(path, signal) });
  } catch (cause: unknown) {
    const capture = failureCapture(found.value, false);
    if (signal?.aborted === true)
      return err(
        new NativeCommandFailure(
          tool,
          "cancelled",
          capture.exitCode,
          { cause },
          capture,
        ),
      );
    return err(
      new NativeCommandFailure(
        tool,
        "io",
        capture.exitCode,
        { cause },
        capture,
      ),
    );
  }
};

type ProcessCapture = Omit<
  NativeCommandCapture,
  | "tool"
  | "executable"
  | "executableSha256"
  | "toolVersion"
  | "versionReason"
  | "arguments"
>;

/** Bound one command's output for failure diagnostics, keeping observed byte totals. */
export const failureCapture = (
  capture: ProcessCapture,
  truncated: boolean,
): NativeCommandFailureCapture => {
  const stdout = boundedUtf8Text(
    capture.stdout,
    NATIVE_FAILURE_DIAGNOSTIC_BYTES,
  );
  const stderr = boundedUtf8Text(
    capture.stderr,
    NATIVE_FAILURE_DIAGNOSTIC_BYTES,
  );
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    // Byte counts stay the observed totals, not the excerpt lengths.
    stdoutBytes: capture.stdoutBytes,
    stderrBytes: capture.stderrBytes,
    exitCode: capture.exitCode,
    signal: capture.signal,
    truncated: truncated || stdout.truncated || stderr.truncated,
  };
};

const captureProcess = async (
  executable: string,
  arguments_: readonly string[],
  tool: string,
  options: {
    readonly signal?: AbortSignal;
    readonly acceptNonZero?: boolean;
  },
  environment: Readonly<NodeJS.ProcessEnv>,
  launcher?: NativeCommandLauncher,
): Promise<Result<ProcessCapture, NativeCommandFailure>> => {
  const runId = `rea-native-command-${randomUUID()}`;
  try {
    const snapshot = await runOwnedCommand(
      {
        command: executable,
        arguments: [...arguments_],
        runId,
        env: {
          LC_ALL: "C",
          LANG: "C",
        },
        hostEnvironment: environment,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      {
        timeoutMs: NATIVE_COMMAND_TIMEOUT_MS,
        diagnosticBytes: NATIVE_COMMAND_OUTPUT_BUDGET_BYTES,
        acceptNonZeroExit: options.acceptNonZero === true,
      },
      launcher === undefined ? {} : { launcher },
    );
    return ok(processCaptureFromSnapshot(snapshot));
  } catch (cause: unknown) {
    if (cause instanceof OwnedCommandFailure) {
      const capture =
        cause.snapshot === null
          ? null
          : failureCapture(
              processCaptureFromSnapshot(cause.snapshot),
              cause.snapshot.diagnosticTruncated === true,
            );
      return err(
        new NativeCommandFailure(
          tool,
          cause.reason === "process"
            ? processFailureReason(capture)
            : cause.reason,
          capture?.exitCode ?? null,
          {
            cause,
            ...(cause.cleanupOwner === undefined
              ? {}
              : { cleanupOwner: cause.cleanupOwner }),
          },
          capture,
          cause.cleanupFailure,
          cause.resources,
        ),
      );
    }
    return err(
      new NativeCommandFailure(tool, "io", null, {
        cause,
        // Process supervision needs the Darwin ownership helper; its typed
        // message names the compiler or SDK prerequisite to fix.
        ...(cause instanceof DarwinProcessOwnershipInspectionError
          ? { detail: cause.message }
          : {}),
      }),
    );
  }
};

const processFailureReason = (
  capture: NativeCommandFailureCapture | null,
): "io" | "nonzero-exit" =>
  capture !== null &&
  (capture.signal !== null ||
    (capture.exitCode !== null && capture.exitCode !== 0))
    ? "nonzero-exit"
    : "io";

const processCaptureFromSnapshot = (
  snapshot: ProviderProcessSnapshot,
): ProcessCapture => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  stdoutBytes: snapshot.stdout.bytes,
  stderrBytes: snapshot.stderr.bytes,
  exitCode: snapshot.exitCode ?? null,
  signal: snapshot.signal ?? null,
});

const hashFile = (path: string, signal?: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(
      path,
      signal === undefined ? undefined : { signal },
    );
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
