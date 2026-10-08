import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";

import { err, ok, type Result } from "../domain/result.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";

/** Maximum wall-clock duration for one native command. */
export const NATIVE_COMMAND_TIMEOUT_MS = 60_000;
/** Retain complete command output up to a bounded aggregate size. */
export const NATIVE_COMMAND_OUTPUT_BUDGET_BYTES = 64 * 1024 * 1024;

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
    options?: ErrorOptions,
    readonly capture: NativeCommandFailureCapture | null = null,
    readonly cleanupFailure: string | null = null,
    readonly cleanupResources: readonly string[] = [],
  ) {
    super(`Native command ${tool} failed: ${reason}`, options);
  }
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
}

/** Resolve one allowlisted native tool to an immutable executable identity. */
export type NativeToolResolver = (
  tool: string,
  signal?: AbortSignal,
) => Promise<Result<ResolvedTool, NativeCommandFailure>>;

/** Run allowlisted Xcode tools directly without a shell. */
export class XcrunCommandRunner implements NativeCommandRunner {
  constructor(
    private readonly resolveTool: NativeToolResolver = (tool, signal) =>
      resolveXcrunTool(tool, signal),
  ) {}

  run(
    tool: string,
    arguments_: readonly string[],
    options: NativeCommandOptions,
  ): Promise<Result<NativeCommandCapture, NativeCommandFailure>> {
    if (!ALLOWED_TOOLS.has(tool))
      return Promise.resolve(
        err(new NativeCommandFailure(tool, "unavailable")),
      );
    return this.resolveTool(tool, options.signal).then(async (resolved) => {
      if (!resolved.ok) return resolved;
      const captured = await captureProcess(
        resolved.value.path,
        arguments_,
        tool,
        options,
      );
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
    });
  }
}

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
  signal?: AbortSignal,
): Promise<Result<ResolvedTool, NativeCommandFailure>> => {
  const found = await captureProcess(
    "/usr/bin/xcrun",
    ["--find", tool],
    "xcrun",
    signal === undefined ? {} : { signal },
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
        { cause: found.error },
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

const failureCapture = (
  capture: ProcessCapture,
  truncated: boolean,
): NativeCommandFailureCapture => ({
  stdout: capture.stdout,
  stderr: capture.stderr,
  stdoutBytes: capture.stdoutBytes,
  stderrBytes: capture.stderrBytes,
  exitCode: capture.exitCode,
  signal: capture.signal,
  truncated,
});

const captureProcess = async (
  executable: string,
  arguments_: readonly string[],
  tool: string,
  options: {
    readonly signal?: AbortSignal;
    readonly acceptNonZero?: boolean;
  },
): Promise<Result<ProcessCapture, NativeCommandFailure>> => {
  const runId = `rea-native-command-${randomUUID()}`;
  try {
    const snapshot = await runOwnedCommand(
      {
        command: executable,
        arguments: [...arguments_],
        runId,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LC_ALL: "C",
          LANG: "C",
        },
        hostEnvironment: {},
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      {
        timeoutMs: NATIVE_COMMAND_TIMEOUT_MS,
        diagnosticBytes: NATIVE_COMMAND_OUTPUT_BUDGET_BYTES,
        acceptNonZeroExit: options.acceptNonZero === true,
      },
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
          { cause },
          capture,
          cause.cleanupFailure,
          cause.resources,
        ),
      );
    }
    return err(new NativeCommandFailure(tool, "io", null, { cause }));
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
