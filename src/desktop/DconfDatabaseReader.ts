import {
  open,
  realpath,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  runOwnedCommand,
  ownedCommandResources,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import { providerOutcomeOf } from "../process/ProviderOutcome.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { retainArtifactCommandCleanup } from "../providers/OwnedCommandCleanup.js";

import {
  assertArtifactReadActive,
  withArtifactFileHandle,
  ArtifactReaderFailure,
  ArtifactResourceScope,
} from "../resources/index.js";

import { programCandidates } from "./ProgramLookup.js";

const DCONF_NOT_INSTALLED =
  "dconf is not installed (dconf-cli); set REA_DCONF_COMMAND";
const DCONF_TIMEOUT_MS = 30_000;
const DCONF_MAX_BUFFER = 16 * 1024 * 1024;

/** Retire a retained command family before its parent-owned database descriptor. */
class DconfReadHandle extends OwnedFileHandle {
  retainedProcess: ProviderProcessSupervisor | undefined;
  readonly inspections = new ArtifactResourceScope();

  constructor(
    file: FileHandle,
    readonly path: string,
  ) {
    super(file);
  }

  get cleanupResources(): readonly string[] {
    const ownership = this.retainedProcess?.launch.ownership;
    return [
      this.path,
      ...(ownership === undefined ? [] : ownedCommandResources(ownership)),
      ...this.inspections.cleanupResources,
    ];
  }

  override async close(): Promise<void> {
    if (this.retainedProcess !== undefined) {
      const stopped = await this.retainedProcess.stop();
      if (stopped.status === "incomplete") throw new Error(stopped.reason);
      this.retainedProcess = undefined;
    }
    await this.inspections.close();
    await super.close();
  }
}

/** The keyfile text of a dconf database, or why it could not be read. */
export type DconfDump =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

/**
 * Read an offline dconf database through a parent-owned read-only descriptor.
 * The profile contains no selected path syntax, and cwd/PATH stay unchanged for
 * wrapper interpreters and helpers. file-db has no live D-Bus authority.
 */
export const dumpDconfDatabase = async (
  database: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<DconfDump> => {
  assertArtifactReadActive(signal);
  let selectedCommand: string | undefined;
  try {
    const directory = await realpath(dirname(database));
    const profile = join(directory, "profile");
    const file = await open(database, "r");
    const owner = new DconfReadHandle(file, database);
    return await withArtifactFileHandle(
      database,
      owner,
      undefined,
      signal,
      async (source) => {
        // dconf silently treats an unreadable file-db as empty. Refuse a host
        // without descriptor paths rather than publish a false empty view.
        // Refer to the owning process: a shell background job replaces stdin,
        // and another interpreter may close inherited non-stdio descriptors.
        const sourcePath = `/proc/${process.pid}/fd/${source.fd}`;
        await stat(sourcePath);
        await writeFile(profile, `file-db:${sourcePath}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        const command = environment.REA_DCONF_COMMAND ?? "dconf";
        // Preserve the first refusal's candidate spelling for diagnostics. cwd and
        // PATH stay unchanged for interpreter and helper lookup as well.
        const startedIn = process.cwd();
        const direct = command.includes("/") || command.includes(sep);
        const candidates = direct
          ? [
              {
                path: isAbsolute(command)
                  ? command
                  : `${startedIn}${sep}${command}`,
              },
            ]
          : programCandidates(
              command,
              { PATH: environment.PATH ?? "" },
              startedIn,
            );
        let refusal: unknown;
        let missing: unknown;
        for (const candidate of candidates) {
          assertArtifactReadActive(signal);
          selectedCommand = candidate.path;
          try {
            const output = await runOwnedCommand(
              {
                command: candidate.path,
                arguments: ["dump", "/"],
                runId: randomUUID(),
                expectedCommand: null,
                hostEnvironment: {
                  PATH: environment.PATH ?? "",
                  DCONF_PROFILE: profile,
                },
                sweepTokenOwnedProcesses: true,
              },
              {
                timeoutMs: DCONF_TIMEOUT_MS,
                diagnosticBytes: {
                  stdout: DCONF_MAX_BUFFER,
                  stderr: DCONF_MAX_BUFFER,
                },
                termination: { signal: "SIGTERM", graceMs: 5_000 },
              },
              {
                ...(signal === undefined ? {} : { signal }),
                retainCleanup: (process) => {
                  owner.retainedProcess = process;
                },
              },
            );
            return { ok: true, text: output.stdout.text };
          } catch (cause: unknown) {
            // Baseline identity inspection can fail before a supervisor exists.
            // Adopt its exact owners before cancellation or diagnostic projection.
            retainArtifactCommandCleanup(
              cause,
              owner.inspections,
              "dconf dump",
            );
            const failure = providerOutcomeOf(cause);
            // Only POSIX PATH-search spawn failures permit another candidate.
            // An actual child exit, cancellation or host capacity failure is final.
            if (
              !direct &&
              failure?.kind === "launch-failed" &&
              (failure.failure.code === "ENOENT" ||
                failure.failure.code === "ENOTDIR" ||
                failure.failure.code === "EACCES")
            ) {
              if (failure.failure.code === "EACCES") refusal ??= cause;
              else missing = cause;
              continue;
            }
            if (failure?.kind === "cancelled")
              throw new ArtifactReaderFailure(
                "cancelled",
                "dconf dump was cancelled",
                {
                  cause: failure.reason,
                  cancellation: { reason: failure.reason },
                },
              );
            throw cause;
          }
        }
        if (refusal !== undefined) throw refusal;
        if (missing !== undefined) throw missing;
        return { ok: false, error: DCONF_NOT_INSTALLED };
      },
    );
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure) throw cause;
    const failure = providerOutcomeOf(cause);
    if (failure?.kind === "launch-failed" && failure.failure.code === "ENOENT")
      return {
        ok: false,
        error: DCONF_NOT_INSTALLED,
      };
    return {
      ok: false,
      error:
        failure?.output?.snapshot.stderr.text.trim() ||
        (failure?.kind === "exited"
          ? `Command failed: ${selectedCommand} dump / (exit ${failure.exitCode ?? failure.signal})`
          : undefined) ||
        failure?.message ||
        String(cause),
    };
  }
};
