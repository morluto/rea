import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { safeParseJson } from "../domain/safeJson.js";
import { boundedUtf8Text } from "./boundedUtf8Text.js";
import { execFileOutput, execFileOutputFailure } from "./ExecFileOutput.js";
import type {
  ProcessIdentityObservation,
  ProcessRunTokenObservation,
  ProcessTableEntry,
} from "./ProcessOwnership.js";

const responseSchema = z.strictObject({
  results: z.array(
    z.discriminatedUnion("state", [
      z.strictObject({
        pid: z.number().int().positive(),
        state: z.literal("readable"),
        run_id: z.string().optional(),
        reason: z.null().optional(),
      }),
      z.strictObject({
        pid: z.number().int().positive(),
        state: z.literal("unavailable"),
        run_id: z.union([z.string(), z.null()]).optional(),
        reason: z.string().min(1),
      }),
    ]),
  ),
});
const identityResponseSchema = z.strictObject({
  results: z.array(
    z.discriminatedUnion("state", [
      z.strictObject({
        pid: z.number().int().positive(),
        state: z.literal("readable"),
        identity: z.string().min(1),
        reason: z.null().optional(),
      }),
      z.strictObject({
        pid: z.number().int().positive(),
        state: z.literal("unavailable"),
        identity: z.null().optional(),
        reason: z.string().min(1),
      }),
    ]),
  ),
});

const sourceFiles = [
  fileURLToPath(
    new URL(
      "../../bridge/process/ProcessRunTokenReader.swift",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../../bridge/process/ProcessRunTokenReaderMain.swift",
      import.meta.url,
    ),
  ),
];

/**
 * swift-driver runs each frontend job in its own process group. On SIGINT it
 * stops those jobs and deletes their objects before exiting; on SIGTERM it
 * exits while a job can still write objects under TMPDIR.
 */
export const SWIFTC_INTERRUPT = "SIGINT";

/** Deadline for the one-shot helper compilation. */
// A fresh Swift SDK cache took 88 seconds on the supported Intel macOS VM.
// Keep compilation bounded independently of short provider version probes.
const COMPILER_TIMEOUT_MS = 120_000;

/** Bound on compiler diagnostics embedded in the inspection failure text. */
const STDERR_EXCERPT_LIMIT = 512;

/** The native Darwin process-ownership reader could not be prepared. */
export class DarwinProcessOwnershipInspectionError extends Error {
  constructor(
    message: string,
    options?: ErrorOptions & {
      readonly compilerOutcome?: DarwinCompilerOutcome;
    },
  ) {
    const { compilerOutcome, ...errorOptions } = options ?? {};
    super(message, errorOptions);
    this.name = "DarwinProcessOwnershipInspectionError";
    this.compilerOutcome = compilerOutcome;
  }

  readonly compilerOutcome: DarwinCompilerOutcome | undefined;
}

/** Explicit, bounded outcome from compiling REA's Darwin ownership helper. */
export interface DarwinCompilerOutcome {
  readonly outcome:
    | "exited"
    | "signaled"
    | "timed_out"
    | "spawn_failed"
    | "failed";
  readonly code: string | number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
  readonly outputTruncated: boolean;
  readonly killed: boolean;
  readonly timeoutMs?: number;
}

const MAX_COMPILER_STDERR_BYTES = 8 * 1024;

const compilerOutcome = (
  cause: unknown,
  timeoutMs: number,
): DarwinCompilerOutcome | undefined => {
  const failure = execFileOutputFailure(cause);
  if (failure === undefined) return undefined;
  const stderr = boundedUtf8Text(failure.stderr, MAX_COMPILER_STDERR_BYTES);
  const outcome =
    failure.code === "ETIMEDOUT"
      ? "timed_out"
      : typeof failure.code === "number"
        ? "exited"
        : failure.signal !== null
          ? "signaled"
          : failure.code === "ENOENT"
            ? "spawn_failed"
            : "failed";
  return {
    outcome,
    code: failure.code,
    signal: failure.signal,
    stderr: stderr.text,
    stderrBytes: Buffer.byteLength(failure.stderr, "utf8"),
    stderrTruncated: stderr.truncated,
    outputTruncated: failure.outputTruncated,
    killed: failure.killed,
    ...(outcome === "timed_out" ? { timeoutMs } : {}),
  };
};

const compilerOutcomeDescription = (
  outcome: DarwinCompilerOutcome | undefined,
  fallbackCode: string | number,
): string => {
  if (outcome === undefined) return `compiler result: ${String(fallbackCode)}`;
  if (outcome.outcome === "exited")
    return `compiler result: exit code ${String(outcome.code)}`;
  if (outcome.outcome === "timed_out")
    return `compiler result: timed out after ${String(outcome.timeoutMs)} ms`;
  if (outcome.outcome === "signaled")
    return `compiler result: stopped by signal ${outcome.signal ?? "an unknown signal"}`;
  return `compiler result: ${String(outcome.code)}`;
};

const compilerInspectionError = (
  cause: unknown,
  timeoutMs: number,
  compiler: DarwinProcessReaderCompiler,
): DarwinProcessOwnershipInspectionError => {
  const outcome = compilerOutcome(cause, timeoutMs);
  const code = outcome?.code ?? "unknown";
  const description = compilerOutcomeDescription(outcome, code);
  const launcher =
    compiler.kind === "xcrun"
      ? "xcrun"
      : "the selected Swift compiler (REA_DARWIN_SWIFTC_PATH)";
  const prefix =
    code === "ENOENT"
      ? `macOS process ownership inspection requires the Apple Swift compiler via ${launcher}`
      : `macOS process ownership helper compilation failed via ${launcher}`;
  const stderr = boundedUtf8Text(outcome?.stderr ?? "", STDERR_EXCERPT_LIMIT);
  const diagnostics = stderr.text.trim();
  const truncated =
    stderr.truncated ||
    outcome?.stderrTruncated === true ||
    outcome?.outputTruncated === true;
  const suffix = diagnostics
    ? `: ${diagnostics}${truncated ? "… [diagnostics truncated]" : ""}`
    : outcome === undefined
      ? `: ${cause instanceof Error ? cause.message : String(cause)}`
      : ": no compiler diagnostics were captured";
  return new DarwinProcessOwnershipInspectionError(
    `${prefix} (${description})${suffix}`,
    {
      cause,
      ...(outcome === undefined ? {} : { compilerOutcome: outcome }),
    },
  );
};

interface ProcessReaderCompilation {
  readonly controller: AbortController;
  promise: Promise<string>;
  waiters: number;
  aborting: boolean;
  settled: boolean;
}

const abortReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
};

const isExpectedAbort = (cause: unknown, signal: AbortSignal): boolean =>
  signal.aborted &&
  (cause === signal.reason ||
    (cause instanceof Error && cause.name === "AbortError"));

const waitForCompilation = async (
  promise: Promise<string>,
  signal: AbortSignal | undefined,
): Promise<string> => {
  if (signal === undefined) return promise;
  if (signal.aborted) throw abortReason(signal);
  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (cause: unknown) => finish(() => reject(cause)),
    );
    if (signal.aborted) onAbort();
  });
};

/** Explicit tool selection; direct Swift compilation also needs its matching SDK. */
export type DarwinProcessReaderCompiler =
  | { readonly kind: "xcrun"; readonly executable: string }
  | {
      readonly kind: "swiftc";
      readonly executable: string;
      readonly sdkRoot: string;
    };

/** Compile and retain the narrow Darwin sysctl reader for this REA process. */
export const createDarwinProcessRunTokenReader = (
  options: {
    readonly compiler?: DarwinProcessReaderCompiler;
    /** Deadline for helper compilation, independent of provider execution. */
    readonly compileTimeoutMs?: number;
    /**
     * Caller-owned directory holding the compiler's module cache. Unset keeps
     * Swift's reusable default cache; a supplied directory outlives this
     * reader because cleanup only removes the per-run helper root.
     */
    readonly moduleCachePath?: string;
  } = {},
) => {
  const compiler = options.compiler ?? {
    kind: "xcrun",
    executable: "/usr/bin/xcrun",
  };
  const compilerTimeoutMs = options.compileTimeoutMs ?? COMPILER_TIMEOUT_MS;
  const moduleCachePath = options.moduleCachePath ?? "";
  let root: string | undefined;
  let executable: string | undefined;
  let compilation: ProcessReaderCompilation | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  let exitCleanupInstalled = false;

  const cleanupAtExit = () => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  };
  const cleanupRoot = async (target = root): Promise<void> => {
    if (target === undefined) return;
    await rm(target, { recursive: true, force: true });
    if (root !== target) return;
    root = undefined;
    executable = undefined;
    if (exitCleanupInstalled) process.removeListener("exit", cleanupAtExit);
    exitCleanupInstalled = false;
  };
  const runCompilation = async (signal: AbortSignal): Promise<string> => {
    let operationRoot: string | undefined;
    try {
      if (
        compiler.kind === "swiftc" &&
        (!isAbsolute(compiler.executable) || !isAbsolute(compiler.sdkRoot))
      ) {
        throw new DarwinProcessOwnershipInspectionError(
          "Direct Darwin helper compilation requires absolute REA_DARWIN_SWIFTC_PATH and SDKROOT paths selecting a compatible installed Swift compiler and macOS SDK.",
        );
      }
      operationRoot = await mkdtemp(join(tmpdir(), "rea-process-token-"));
      root = operationRoot;
      process.once("exit", cleanupAtExit);
      exitCleanupInstalled = true;
      if (signal.aborted || closed) throw abortReason(signal);
      const output = join(operationRoot, "reader");
      // swiftc keeps intermediate objects under TMPDIR, so keep them inside
      // the root that cleanup removes.
      const compilerTemporary = join(operationRoot, "tmp");
      await mkdir(compilerTemporary);
      const compilerEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        TMPDIR: compilerTemporary,
      };
      const compilerArguments =
        compiler.kind === "xcrun" ? ["swiftc"] : ["-sdk", compiler.sdkRoot];
      if (compiler.kind === "swiftc")
        compilerEnvironment.SDKROOT = compiler.sdkRoot;
      if (moduleCachePath === "") {
        // Use Swift's reusable default cache for REA's internal helper compilation.
        delete compilerEnvironment.CLANG_MODULE_CACHE_PATH;
      } else {
        await mkdir(moduleCachePath, { recursive: true });
        compilerArguments.push("-module-cache-path", moduleCachePath);
        compilerEnvironment.CLANG_MODULE_CACHE_PATH = moduleCachePath;
      }
      compilerArguments.push(...sourceFiles, "-o", output);
      try {
        await execFileOutput(compiler.executable, compilerArguments, {
          timeout: compilerTimeoutMs,
          maxBuffer: 1024 * 1024,
          signal,
          stopSignal: SWIFTC_INTERRUPT,
          env: compilerEnvironment,
        });
      } catch (cause: unknown) {
        if (isExpectedAbort(cause, signal)) throw cause;
        throw compilerInspectionError(cause, compilerTimeoutMs, compiler);
      }
      if (signal.aborted || closed) throw abortReason(signal);
      executable = output;
      return output;
    } catch (cause: unknown) {
      const ownsRoot = operationRoot !== undefined && root === operationRoot;
      if (operationRoot !== undefined) {
        if (ownsRoot) await cleanupRoot(operationRoot);
        else await rm(operationRoot, { recursive: true, force: true });
      }
      throw cause;
    }
  };

  const beginCompilation = (): ProcessReaderCompilation => {
    const controller = new AbortController();
    const operation: ProcessReaderCompilation = {
      controller,
      promise: runCompilation(controller.signal).finally(() => {
        operation.settled = true;
        if (compilation === operation) compilation = undefined;
      }),
      waiters: 0,
      aborting: false,
      settled: false,
    };
    compilation = operation;
    return operation;
  };

  const compile = async (signal?: AbortSignal): Promise<string> => {
    if (closed) throw new Error("Darwin process token reader is closed");
    signal?.throwIfAborted();
    while (true) {
      if (closed) throw new Error("Darwin process token reader is closed");
      signal?.throwIfAborted();
      if (executable !== undefined) return executable;
      if (compilation === undefined && root !== undefined) {
        await cleanupRoot();
        continue;
      }
      let operation = compilation;
      if (operation?.aborting === true) {
        try {
          await waitForCompilation(operation.promise, signal);
        } catch (cause: unknown) {
          if (signal !== undefined && isExpectedAbort(cause, signal))
            throw cause;
        }
        continue;
      }
      operation ??= beginCompilation();
      operation.waiters += 1;
      try {
        return await waitForCompilation(operation.promise, signal);
      } finally {
        operation.waiters -= 1;
        if (
          operation.waiters === 0 &&
          !operation.settled &&
          !operation.aborting
        ) {
          operation.aborting = true;
          operation.controller.abort();
          await operation.promise.catch(() => undefined);
        }
      }
    }
  };

  const read = async (
    processes: readonly ProcessTableEntry[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<number, ProcessRunTokenObservation>> => {
    signal?.throwIfAborted();
    if (processes.length === 0) return new Map();
    const binary = await compile(signal);
    const pids = processes.map(({ pid }) => String(pid));
    const { stdout } = await execFileOutput(binary, pids, {
      timeout: 15_000,
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();
    const decoded = safeParseJson(stdout);
    if (!decoded.ok)
      throw new Error(
        `macOS process token helper returned invalid JSON: ${decoded.error}`,
        { cause: decoded.cause },
      );
    const parsed = responseSchema.safeParse(decoded.value);
    if (!parsed.success)
      throw new Error(
        "macOS process token helper returned an invalid response",
        {
          cause: parsed.error,
        },
      );
    const requested = new Set(processes.map(({ pid }) => pid));
    const observations = new Map<number, ProcessRunTokenObservation>();
    for (const result of parsed.data.results) {
      if (!requested.has(result.pid) || observations.has(result.pid))
        throw new Error(
          "macOS process token helper returned an unexpected PID set",
        );
      observations.set(
        result.pid,
        result.state === "readable"
          ? { state: "readable", runId: result.run_id }
          : {
              state: "unavailable",
              reason:
                result.reason ?? "process token observation is unavailable",
            },
      );
    }
    if (observations.size !== requested.size)
      throw new Error(
        "macOS process token helper returned an incomplete PID set",
      );
    return observations;
  };

  const identities = async (
    processes: readonly ProcessTableEntry[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<number, ProcessIdentityObservation>> => {
    if (processes.length === 0) return new Map();
    const binary = await compile(signal);
    const pids = processes.map(({ pid }) => String(pid));
    const { stdout } = await execFileOutput(binary, ["--identities", ...pids], {
      timeout: 15_000,
      ...(signal === undefined ? {} : { signal }),
    });
    const decoded = safeParseJson(stdout);
    if (!decoded.ok)
      throw new Error(
        `macOS process identity helper returned invalid JSON: ${decoded.error}`,
        { cause: decoded.cause },
      );
    const parsed = identityResponseSchema.safeParse(decoded.value);
    if (!parsed.success)
      throw new Error(
        "macOS process identity helper returned an invalid response",
        {
          cause: parsed.error,
        },
      );
    const requested = new Set(processes.map(({ pid }) => pid));
    const observations = new Map<number, ProcessIdentityObservation>();
    for (const result of parsed.data.results) {
      if (!requested.has(result.pid) || observations.has(result.pid))
        throw new Error(
          "macOS process identity helper returned an unexpected PID set",
        );
      observations.set(
        result.pid,
        result.state === "readable"
          ? { state: "readable", identity: result.identity }
          : { state: "unavailable", reason: result.reason },
      );
    }
    if (observations.size !== requested.size)
      throw new Error(
        "macOS process identity helper returned an incomplete PID set",
      );
    return observations;
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    const pendingClose = (async () => {
      const operation = compilation;
      if (operation !== undefined && !operation.settled) {
        operation.aborting = true;
        operation.controller.abort();
        await operation.promise.catch(() => undefined);
      }
      await cleanupRoot();
    })().catch((cause: unknown) => {
      if (closePromise === pendingClose) closePromise = undefined;
      throw cause;
    });
    closePromise = pendingClose;
    return closePromise;
  };

  return { read, identities, prepare: compile, close };
};
