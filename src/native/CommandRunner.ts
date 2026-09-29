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
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export class NativeCommandFailure extends Error {
  constructor(
    readonly tool: string,
    readonly reason: "unavailable" | "cancelled" | "nonzero-exit" | "io",
    readonly exitCode: number | null = null,
    options?: ErrorOptions,
  ) {
    super(`Native command ${tool} failed: ${reason}`, options);
  }
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
  readonly #resolved = new Map<string, ResolvedTool>();

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
    return this.#resolve(tool, options.signal).then(async (resolved) => {
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
    signal?: AbortSignal,
  ): Promise<Result<ResolvedTool, NativeCommandFailure>> {
    const existing = this.#resolved.get(tool);
    if (existing !== undefined) return ok(existing);
    const resolved = await this.resolveTool(tool, signal);
    if (resolved.ok) this.#resolved.set(tool, resolved.value);
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
  signal?: AbortSignal,
): Promise<Result<ResolvedTool, NativeCommandFailure>> => {
  const found = await captureProcess(
    "/usr/bin/xcrun",
    ["--find", tool],
    "xcrun",
    signal === undefined ? {} : { signal },
  );
  if (!found.ok) {
    if (found.error.reason === "cancelled")
      return err(new NativeCommandFailure(tool, "cancelled"));
    return err(new NativeCommandFailure(tool, "unavailable"));
  }
  if (found.value.exitCode !== 0)
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
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const stop = (failure: NativeCommandFailure["reason"]): void => {
      reason ??= failure;
      child.kill("SIGKILL");
    };
    const onAbort = (): void => stop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr.push(chunk);
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
