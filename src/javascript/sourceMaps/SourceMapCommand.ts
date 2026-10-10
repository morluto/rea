import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { WEB_SOURCE_MAP_LIMITS } from "../../domain/webSourceLocation.js";
import {
  PrivateRuntimeRoot,
  PrivateRuntimeRootUnavailableError,
} from "../../process/PrivateRuntimeRoot.js";
import { ProviderStartupDeadline } from "../../process/ProviderDeadline.js";
import { cleanupOwnedProcessGroup } from "../../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
} from "../../process/ProviderProcess.js";
import { prepareProcessOwnershipInspection } from "../../process/ProcessOwnershipObservation.js";

const OPERATION = "trace_web_source_location";
const PROVIDER = "source-map-decoder";
/** Launcher seam retains the actual codec protocol and ownership supervisor. */
export type SourceMapCodecLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;
/** Runtime implementations establish privacy before returning an owned directory. */
export interface SourceMapCodecRuntime {
  readonly path: string;
  close(): Promise<void>;
}
/** Replaceable acquisition boundaries for an owned codec operation. */
export interface SourceMapDecoderDependencies {
  readonly launcher?: SourceMapCodecLauncher;
  readonly createRuntime?: () => Promise<SourceMapCodecRuntime>;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** Prepare host ownership inspection outside the codec execution deadline. */
  readonly prepareOwnership?: (signal?: AbortSignal) => Promise<void>;
}

export interface SourceMapCleanupOwner {
  close(
    previousError: string | null,
  ): Promise<ProviderCleanupError | undefined>;
}

export class SourceMapCleanupFailure extends ProviderCleanupError {
  constructor(
    readonly cleanupOwner: SourceMapCleanupOwner,
    resources: readonly string[],
    diagnostics: Readonly<Record<string, JsonValue>>,
  ) {
    super(PROVIDER, resources, diagnostics, { operation: OPERATION });
  }
}

/** Run a trusted codec command and release its process/root before returning output. */
export const runSourceMapCommand = async (
  request: string,
  path: string,
  options: ExecutionOptions | undefined,
  dependencies: SourceMapDecoderDependencies,
): Promise<Result<string, AnalysisError>> => {
  try {
    await (dependencies.prepareOwnership ?? prepareProcessOwnershipInspection)(
      options?.signal,
    );
  } catch (cause: unknown) {
    return err(
      options?.signal?.aborted === true
        ? new AnalysisCancelledError(OPERATION)
        : new ProviderAdapterError(PROVIDER, OPERATION, {
            cause,
            diagnostics: {
              map_path: path,
              error_message: message(cause),
              phase: "process_ownership_preparation",
            },
          }),
    );
  }
  const deadline = new ProviderStartupDeadline(
    WEB_SOURCE_MAP_LIMITS.decodeTimeoutMs,
    options?.signal,
  );
  const command = new OwnedCodec(path, dependencies, deadline);
  let result: Result<string, AnalysisError>;
  try {
    await command.start(request);
    result = ok(await command.collect());
  } catch (cause: unknown) {
    result = err(command.failure(cause));
  } finally {
    deadline.dispose();
  }
  const cleanup = await command.close(result.ok ? null : result.error.message);
  if (cleanup !== undefined) return err(cleanup);
  return result.ok && options?.signal?.aborted
    ? err(new AnalysisCancelledError(OPERATION))
    : result;
};

class OwnedCodec implements SourceMapCleanupOwner {
  readonly #runId = `rea-source-map-${randomUUID()}`;
  #runtime: SourceMapCodecRuntime | undefined;
  #supervisor: ProviderProcessSupervisor | undefined;
  #oversized = false;
  #processError: string | undefined;
  constructor(
    readonly path: string,
    readonly dependencies: SourceMapDecoderDependencies,
    readonly deadline: ProviderStartupDeadline,
  ) {}

  async start(request: string): Promise<void> {
    this.check();
    this.#runtime = await (
      this.dependencies.createRuntime ??
      (() => PrivateRuntimeRoot.create({ prefix: "rea-source-map-" }))
    )();
    this.check();
    const requestPath = join(this.#runtime.path, "request.json");
    await writeFile(requestPath, request, {
      flag: "wx",
      mode: 0o600,
      signal: this.deadline.signal,
    });
    this.check();
    const environment: NodeJS.ProcessEnv = {
      ...(this.dependencies.environment ?? process.env),
      UV_THREADPOOL_SIZE: "1",
    };
    delete environment.NODE_OPTIONS;
    const spawned = await (
      this.dependencies.launcher ?? spawnOwnedProviderProcess
    )({
      command: process.execPath,
      arguments: [
        "--max-old-space-size=192",
        "--max-semi-space-size=8",
        "--v8-pool-size=1",
        "--single-threaded",
        "--stack_size=2048",
        fileURLToPath(new URL("./SourceMapCodecProcess.js", import.meta.url)),
        requestPath,
      ],
      runId: this.#runId,
      cwd: this.#runtime.path,
      hostEnvironment: environment,
      signal: this.deadline.signal,
    });
    this.#supervisor = new ProviderProcessSupervisor(
      {
        ...spawned,
        ownsProcessLifetime: true,
        cleanup:
          spawned.cleanup ??
          (() => cleanupOwnedProcessGroup(spawned.ownership)),
      },
      {
        onDiagnostic: (event) => {
          if (event.type === "error") this.#processError = event.message;
          if (
            event.type === "output" &&
            event.totalBytes >
              (event.stream === "stdout"
                ? WEB_SOURCE_MAP_LIMITS.outputBytes
                : 1024 * 1024)
          )
            this.#oversized = true;
        },
      },
    );
  }

  async collect(): Promise<string> {
    const supervisor = this.#supervisor;
    if (supervisor === undefined)
      throw new Error("Codec process was not acquired");
    while (!(await supervisor.waitForOutputClose(50))) this.check();
    this.check();
    const snapshot = supervisor.snapshot();
    if (snapshot.exitCode !== 0 || snapshot.signal !== null)
      throw new ProviderAdapterError(PROVIDER, OPERATION, {
        diagnostics: {
          map_path: this.path,
          exit_code: snapshot.exitCode ?? null,
          signal: snapshot.signal ?? null,
          stderr: snapshot.stderr.text,
        },
      });
    return snapshot.stdout.text;
  }

  check(): void {
    if (this.deadline.interruption === "cancelled")
      throw new AnalysisCancelledError(OPERATION);
    if (this.deadline.interruption === "timeout")
      throw new AnalysisTimeoutError(
        OPERATION,
        WEB_SOURCE_MAP_LIMITS.decodeTimeoutMs,
      );
    if (this.#oversized)
      throw new AnalysisOutputError(
        OPERATION,
        "Codec output exceeds its complete-evidence or diagnostic budget.",
      );
    if (this.#processError !== undefined)
      throw new ProviderAdapterError(PROVIDER, OPERATION, {
        diagnostics: { map_path: this.path, error_message: this.#processError },
      });
  }

  failure(cause: unknown): AnalysisError {
    if (this.deadline.interruption === "cancelled")
      return new AnalysisCancelledError(OPERATION);
    if (this.deadline.interruption === "timeout")
      return new AnalysisTimeoutError(
        OPERATION,
        WEB_SOURCE_MAP_LIMITS.decodeTimeoutMs,
      );
    if (cause instanceof AnalysisError) return cause;
    return cause instanceof PrivateRuntimeRootUnavailableError
      ? new AnalysisCapabilityUnavailableError(
          PROVIDER,
          OPERATION,
          cause.message,
          { cause },
        )
      : new ProviderAdapterError(PROVIDER, OPERATION, {
          cause,
          diagnostics: { map_path: this.path, error_message: message(cause) },
        });
  }

  async close(
    previousError: string | null,
  ): Promise<ProviderCleanupError | undefined> {
    const failures: string[] = [];
    let processReleased = this.#supervisor === undefined;
    if (this.#supervisor !== undefined) {
      const stopped = await this.#supervisor.stop();
      if (stopped.status === "incomplete") failures.push(stopped.reason);
      else {
        processReleased = true;
        this.#supervisor = undefined;
      }
    }
    if (processReleased && this.#runtime !== undefined) {
      try {
        await this.#runtime.close();
        this.#runtime = undefined;
      } catch (cause: unknown) {
        failures.push(message(cause));
      }
    }
    return failures.length === 0
      ? undefined
      : new SourceMapCleanupFailure(
          this,
          [
            this.#runId,
            ...(this.#runtime === undefined ? [] : [this.#runtime.path]),
          ],
          {
            map_path: this.path,
            cleanup_failures: failures,
            previous_error: previousError,
            codec_pid: this.#supervisor?.launch.process.pid ?? null,
          },
        );
  }
}
const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
