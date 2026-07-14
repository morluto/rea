import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { spawn } from "node:child_process";

import { err, ok, type Result } from "../domain/result.js";

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
  /** Successful captures are exhaustive; output-limit exits return a failure. */
  readonly stdoutTruncated: false;
  /** Successful captures are exhaustive; output-limit exits return a failure. */
  readonly stderrTruncated: false;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

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
  ) {
    super(`Native command ${tool} failed: ${reason}`, options);
  }
}

export interface NativeCommandRunner {
  run(
    tool: string,
    arguments_: readonly string[],
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly acceptNonZero?: boolean;
    },
  ): Promise<Result<NativeCommandCapture, NativeCommandFailure>>;
}

/** Resolve one allowlisted native tool to an immutable executable identity. */
export type NativeToolResolver = (
  tool: string,
) => Promise<Result<ResolvedTool, NativeCommandFailure>>;

/** Run allowlisted Xcode tools directly with bounded output and no shell. */
export class XcrunCommandRunner implements NativeCommandRunner {
  readonly #resolved = new Map<
    string,
    Promise<Result<ResolvedTool, NativeCommandFailure>>
  >();

  constructor(
    private readonly resolveTool: NativeToolResolver = (tool) =>
      resolveXcrunTool(tool),
  ) {}

  run(
    tool: string,
    arguments_: readonly string[],
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly acceptNonZero?: boolean;
    },
  ): Promise<Result<NativeCommandCapture, NativeCommandFailure>> {
    if (!ALLOWED_TOOLS.has(tool))
      return Promise.resolve(
        err(new NativeCommandFailure(tool, "unavailable")),
      );
    return this.#resolve(tool).then(async (resolved) => {
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
              "Tool exposes no uniform stable version flag; executable digest identifies it.",
            arguments: [...arguments_],
          })
        : captured;
    });
  }

  async #resolve(
    tool: string,
  ): Promise<Result<ResolvedTool, NativeCommandFailure>> {
    const existing = this.#resolved.get(tool);
    if (existing !== undefined) return existing;
    const pending = this.resolveTool(tool);
    this.#resolved.set(tool, pending);
    const resolved = await pending;
    if (!resolved.ok && this.#resolved.get(tool) === pending)
      this.#resolved.delete(tool);
    return resolved;
  }
}

/** Immutable executable identity returned by native tool discovery. */
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

const resolveXcrunTool = async (
  tool: string,
): Promise<Result<ResolvedTool, NativeCommandFailure>> => {
  const found = await captureProcess(
    "/usr/bin/xcrun",
    ["--find", tool],
    "xcrun",
    { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
  );
  if (!found.ok || found.value.exitCode !== 0)
    return err(new NativeCommandFailure(tool, "unavailable"));
  const candidate = found.value.stdout.trim();
  if (!candidate.startsWith("/"))
    return err(new NativeCommandFailure(tool, "unavailable"));
  try {
    const path = await realpath(candidate);
    return ok({ path, sha256: await hashFile(path) });
  } catch (cause: unknown) {
    return err(new NativeCommandFailure(tool, "io", null, { cause }));
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

const captureProcess = (
  executable: string,
  arguments_: readonly string[],
  tool: string,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly acceptNonZero?: boolean;
  },
): Promise<Result<ProcessCapture, NativeCommandFailure>> =>
  new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve(err(new NativeCommandFailure(tool, "cancelled")));
      return;
    }
    const runToken = randomUUID();
    const child = spawn(executable, [...arguments_], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LC_ALL: "C",
        LANG: "C",
        REA_NATIVE_RUN_TOKEN: runToken,
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let reason: NativeCommandFailure["reason"] | undefined;
    const finish = (
      result: Result<ProcessCapture, NativeCommandFailure>,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const stop = (failure: NativeCommandFailure["reason"]): void => {
      reason ??= failure;
      child.kill("SIGKILL");
    };
    const onAbort = (): void => stop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes + stderrBytes > options.maxOutputBytes)
        stop("output-limit");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > options.maxOutputBytes)
        stop("output-limit");
      else stderr.push(chunk);
    });
    child.once("error", (cause: unknown) =>
      finish(err(new NativeCommandFailure(tool, "io", null, { cause }))),
    );
    child.once("close", (code, signal) => {
      if (reason !== undefined) {
        finish(err(new NativeCommandFailure(tool, reason, code)));
        return;
      }
      if (code !== 0 && options.acceptNonZero !== true) {
        finish(err(new NativeCommandFailure(tool, "nonzero-exit", code)));
        return;
      }
      finish(
        ok({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdoutBytes,
          stderrBytes,
          stdoutTruncated: false,
          stderrTruncated: false,
          exitCode: code,
          signal,
        }),
      );
    });
  });

const hashFile = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
