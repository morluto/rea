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

/** Compile and retain the narrow Darwin sysctl reader for this REA process. */
export const createDarwinProcessRunTokenReader = (
  options: { readonly xcrun?: string } = {},
) => {
  let root: string | undefined;
  let executable: string | undefined;
  let compilePromise: Promise<string> | undefined;
  let closed = false;
  let exitCleanupInstalled = false;

  const cleanupAtExit = () => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  };
  const compile = async (signal?: AbortSignal): Promise<string> => {
    if (closed) throw new Error("Darwin process token reader is closed");
    if (executable !== undefined) return executable;
    if (compilePromise !== undefined) return compilePromise;
    compilePromise = (async () => {
      root = await mkdtemp(join(tmpdir(), "rea-process-token-"));
      process.once("exit", cleanupAtExit);
      exitCleanupInstalled = true;
      const output = join(root, "reader");
      try {
        await execFileOutput(
          options.xcrun ?? "/usr/bin/xcrun",
          [
            "swiftc",
            "-module-cache-path",
            join(root, "modules"),
            ...sourceFiles,
            "-o",
            output,
          ],
          {
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
            ...(signal === undefined ? {} : { signal }),
          },
        );
      } catch (cause: unknown) {
        const code =
          cause instanceof Error && "code" in cause
            ? String(cause.code)
            : "unknown";
        throw new DarwinProcessOwnershipInspectionError(
          `macOS process ownership inspection requires the Apple Swift compiler via xcrun (compiler result: ${code})`,
          { cause },
        );
      }
      executable = output;
      return output;
    })();
    try {
      return await compilePromise;
    } catch (cause: unknown) {
      if (exitCleanupInstalled) process.removeListener("exit", cleanupAtExit);
      exitCleanupInstalled = false;
      if (root !== undefined) await rm(root, { recursive: true, force: true });
      root = undefined;
      executable = undefined;
      compilePromise = undefined;
      throw cause;
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
  ): Promise<ReadonlyMap<number, ProcessIdentityObservation>> => {
    if (processes.length === 0) return new Map();
    const binary = await compile();
    const pids = processes.map(({ pid }) => String(pid));
    const { stdout } = await execFileOutput(binary, ["--identities", ...pids], {
      timeout: 15_000,
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

  const close = async () => {
    if (closed) return;
    closed = true;
    if (exitCleanupInstalled) process.removeListener("exit", cleanupAtExit);
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
    executable = undefined;
  };

  return { read, identities, prepare: compile, close };
};
