import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { safeParseJson } from "../domain/safeJson.js";
import { execFileOutput } from "./ExecFileOutput.js";
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

/** The native Darwin process-ownership reader could not be prepared. */
export class DarwinProcessOwnershipInspectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DarwinProcessOwnershipInspectionError";
  }
}

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

/** Compile and retain the narrow Darwin sysctl reader for this REA process. */
export const createDarwinProcessRunTokenReader = (
  options: { readonly xcrun?: string } = {},
) => {
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
      operationRoot = await mkdtemp(join(tmpdir(), "rea-process-token-"));
      root = operationRoot;
      process.once("exit", cleanupAtExit);
      exitCleanupInstalled = true;
      if (signal.aborted || closed) throw abortReason(signal);
      const output = join(operationRoot, "reader");
      const compilerEnvironment = { ...process.env };
      // Use Swift's reusable default cache for REA's internal helper compilation.
      delete compilerEnvironment.CLANG_MODULE_CACHE_PATH;
      try {
        await execFileOutput(
          options.xcrun ?? "/usr/bin/xcrun",
          ["swiftc", ...sourceFiles, "-o", output],
          {
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
            signal,
            env: compilerEnvironment,
          },
        );
      } catch (cause: unknown) {
        if (isExpectedAbort(cause, signal)) throw cause;
        const code =
          cause instanceof Error && "code" in cause
            ? String(cause.code)
            : "unknown";
        throw new DarwinProcessOwnershipInspectionError(
          code === "ENOENT"
            ? `macOS process ownership inspection requires the Apple Swift compiler via xcrun (compiler result: ${code})`
            : `macOS process ownership helper compilation failed via xcrun (compiler result: ${code}): ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
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
  ): Promise<ReadonlyMap<number, ProcessRunTokenObservation>> => {
    if (processes.length === 0) return new Map();
    const binary = await compile();
    const pids = processes.map(({ pid }) => String(pid));
    const { stdout } = await execFileOutput(binary, pids, { timeout: 15_000 });
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
