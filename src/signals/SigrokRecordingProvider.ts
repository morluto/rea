import {
  type InspectSignalDecodersInput,
  signalDecodersSchema,
} from "../domain/signals/signalDecoders.js";
import {
  DecoderDiscoveryBudgetError,
  parseDecoderDiscovery,
} from "./parseDecoderDiscovery.js";
import {
  BOUNDED_PRODUCER_LIMITS as LIMITS,
  prlimitArgumentVector,
  readLinuxResourceLimits,
  type LinuxResourceLimits,
} from "../process/LinuxResourceLimits.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { SignalRecordingPort } from "../application/signals/SignalRecordingService.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactAnalysisResources,
  type ArtifactAnalysisRuntime,
} from "../process/ArtifactAnalysisResources.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { createEvidence } from "../domain/evidence.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { windowAnnotationText } from "../domain/signals/annotationTextWindow.js";
import {
  type DecodeSignalRecordingInput,
  signalRecordingSchema,
} from "../domain/signals/signalRecording.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  runOwnedCommand,
  OwnedCommandFailure,
} from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";

const OPERATION = "decode_signal_recording";
export const SIGROK_PROVIDER_IDENTITY = {
  id: "sigrok-recording",
  name: "REA sigrok recording adapter",
  version: "sigrok-cli@0.7.2",
} as const;
type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];

/** Decode selected recordings only, retaining cleanup ownership across failures. */
export class SigrokRecordingProvider implements SignalRecordingPort {
  readonly #resources: ArtifactAnalysisResources;
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: Launcher,
    readonly createRuntime: () => Promise<ArtifactAnalysisRuntime> = () =>
      PrivateRuntimeRoot.create({ prefix: "rea-sigrok-" }),
    readonly platform: NodeJS.Platform = process.platform,
    readonly readArtifact: typeof readStableArtifact = readStableArtifact,
    readonly readLimits: typeof readLinuxResourceLimits = readLinuxResourceLimits,
  ) {
    this.#resources = new ArtifactAnalysisResources(
      SIGROK_PROVIDER_IDENTITY.id,
      OPERATION,
      readArtifact,
      readLimits,
      {
        message:
          "A sigrok operation is already active; retry after it completes.",
        details: { max_concurrent_decodes: 1 },
      },
    );
  }
  decode(
    input: DecodeSignalRecordingInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    return this.#resources.run(
      () => this.#executeRequest(input, options),
      options?.signal,
    );
  }
  inspectDecoders(
    input: InspectSignalDecodersInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    return this.#resources.run(
      () => this.#executeRequest(input, options),
      options?.signal,
      "inspect_signal_decoders",
    );
  }
  close(): Promise<void> {
    return this.#resources.close();
  }
  async #executeRequest(
    input: DecodeSignalRecordingInput | InspectSignalDecodersInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const operation = "path" in input ? OPERATION : "inspect_signal_decoders";
    let phase:
      | "configuration"
      | "artifact"
      | "workspace"
      | "producer"
      | "integrity" = "configuration";
    let capturedOutput: AnalysisCapturedOutput | undefined;
    let resourcePath = "path" in input ? input.path : "sigrok decoder catalog";
    let effectiveLimits: LinuxResourceLimits | undefined;
    let root: ArtifactAnalysisRuntime | undefined;
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(operation);
      await this.#resources.release();
      if (this.platform !== "linux")
        throw new Error(
          "Signal decoding requires Linux with util-linux prlimit and REA_SIGROK_COMMAND so expanded recordings are processed under an enforced address-space limit.",
        );
      const configured = this.environment.REA_SIGROK_COMMAND ?? "";
      if (!isAbsolute(configured))
        throw new Error(
          "Supply absolute REA_SIGROK_COMMAND for sigrok-cli 0.7.2 with libsigrokdecode.",
        );
      const command = await realpath(configured);
      await access(command, constants.X_OK);
      const tool = await this.#resources.read(
        command,
        64 * 1024 * 1024,
        options?.signal,
      );
      const configuredLimiter =
        this.environment.REA_SIGROK_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";
      if (!isAbsolute(configuredLimiter))
        throw new Error("REA_SIGROK_PRLIMIT_COMMAND must be absolute.");
      const limiter = await realpath(configuredLimiter);
      await access(limiter, constants.X_OK);
      const limiterIdentity = await this.#resources.read(
        limiter,
        64 * 1024 * 1024,
        options?.signal,
      );
      effectiveLimits = await this.#resources.readLimits(LIMITS);
      const limitArguments = prlimitArgumentVector(effectiveLimits, command);
      phase = "workspace";
      root = await this.createRuntime();
      this.#resources.retain(root, undefined);
      const snapshotPath = join(root.path, "recording");
      const execute = async (args: readonly string[]) => {
        const output = await runOwnedCommand(
          {
            command: limiter,
            arguments: [...limitArguments, ...args],
            ...(root === undefined ? {} : { cwd: root.path }),
            expectedCommand: null,
            runId: `rea-sigrok-${randomUUID()}`,
            hostEnvironment: this.environment,
          },
          {
            timeoutMs: LIMITS.command_timeout_ms,
            diagnosticBytes: LIMITS.output_bytes,
            acceptNonZeroExit: true,
          },
          {
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
            ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
          },
        );
        capturedOutput = {
          stdout: output.stdout.text,
          stderr: output.stderr.text,
          truncated: output.diagnosticTruncated ?? false,
          exit_code: output.exitCode ?? null,
          signal: output.signal ?? null,
        };
        // Finish bounded integrity checks after output; service handles late cancellation with Evidence.
        const previousPhase = phase;
        phase = "integrity";
        resourcePath = command;
        const current = await this.#resources.read(command, 64 * 1024 * 1024);
        resourcePath = limiter;
        const currentLimiter = await this.#resources.read(
          limiter,
          64 * 1024 * 1024,
        );
        if (currentLimiter.sha256 !== limiterIdentity.sha256)
          throw new AnalysisArtifactChangedError(
            operation,
            limiter,
            "Configured resource limiter changed during analysis.",
            { capturedOutput },
          );
        if (current.sha256 !== tool.sha256)
          throw new AnalysisArtifactChangedError(
            operation,
            command,
            "Configured decoder executable changed during analysis.",
            { capturedOutput },
          );
        phase = previousPhase;
        resourcePath = "path" in input ? input.path : command;
        if (output.exitCode !== 0)
          throw new ProviderAdapterError(
            SIGROK_PROVIDER_IDENTITY.id,
            operation,
            {
              diagnostics: {
                exit_code: output.exitCode ?? null,
                stdout: output.stdout.text,
                stderr: output.stderr.text,
              },
            },
          );
        return output;
      };
      phase = "configuration";
      const version = await execute(["--version"]);
      if (
        !/^sigrok-cli 0\.7\.2(?:\r?\n|$)/u.test(version.stdout.text) ||
        !version.stdout.text.includes("libsigrokdecode")
      )
        throw new Error(
          "Expected sigrok-cli 0.7.2 with libsigrokdecode; inspect the selected installation.",
        );
      const metadata = (args: readonly string[], diagnostics: string) => ({
        diagnostics,
        tool: {
          configured_path: configured,
          path: command,
          sha256: tool.sha256,
          version_banner: version.stdout.text,
          version_diagnostics: version.stderr.text,
          arguments: [...args],
        },
        resource_limiter: {
          configured_path: configuredLimiter,
          path: limiter,
          sha256: limiterIdentity.sha256,
          arguments: limitArguments,
        },
        limits: { ...LIMITS, ...effectiveLimits },
        hardware_acquisition: "not-performed" as const,
      });
      if (!("path" in input)) {
        phase = "producer";
        const args =
          input.decoder === null
            ? ["--dont-scan", "--list-supported"]
            : ["--dont-scan", `--protocol-decoders=${input.decoder}`, "--show"];
        const output = await execute(args);
        const report = signalDecodersSchema.parse({
          selection: input,
          ...parseDecoderDiscovery(output.stdout.text, input),
          ...metadata(args, output.stderr.text),
        });
        result = ok(
          createAnalysisExecution(report, SIGROK_PROVIDER_IDENTITY, {
            subject: { path: command, sha256: tool.sha256, format: "file" },
            limitations: [
              "Catalog and help are observed from the selected sigrok installation. Help lines preserve producer descriptions, not a separately validated parameter schema.",
              "Each request probes the installation again; pages do not share a frozen catalog. Decoder modules and libraries are trusted and not fully fingerprinted.",
              "Hardware discovery, recording reads and acquisition are not requested. Linux per-process limits and bounded output apply; this is not an OS sandbox.",
            ],
          }),
        );
      } else {
        phase = "artifact";
        const selected = await this.#resources.read(
          input.path,
          LIMITS.input_bytes,
          options?.signal,
        );
        phase = "workspace";
        await writeFile(snapshotPath, selected.bytes, {
          flag: "wx",
          mode: 0o400,
        });
        phase = "producer";
        const args = [
          "--dont-scan",
          "--input-file=recording",
          `--protocol-decoders=${input.decoders}`,
          "--protocol-decoder-samplenum",
          ...(input.input_format === null
            ? []
            : [`--input-format=${input.input_format}`]),
          ...(input.annotations === null
            ? []
            : [`--protocol-decoder-annotations=${input.annotations}`]),
        ];
        const output = await execute(args);
        phase = "integrity";
        resourcePath = snapshotPath;
        if (
          (await this.#resources.read(snapshotPath, LIMITS.input_bytes))
            .sha256 !== selected.sha256
        )
          throw new AnalysisArtifactChangedError(
            operation,
            snapshotPath,
            "Decoder changed the private recording copy.",
            capturedOutput === undefined ? {} : { capturedOutput },
          );
        phase = "producer";
        resourcePath = "path" in input ? input.path : command;
        const report = signalRecordingSchema.parse({
          artifact: {
            path: input.path,
            sha256: selected.sha256,
            bytes: selected.bytes.length,
          },
          selection: input,
          ...windowAnnotationText(
            output.stdout.text,
            input.line_offset,
            input.line_limit,
          ),
          ...metadata(args, output.stderr.text),
        });
        result = ok(
          createAnalysisExecution(report, SIGROK_PROVIDER_IDENTITY, {
            subject: {
              path: input.path,
              sha256: selected.sha256,
              format: "file",
            },
            locations: [{ kind: "artifact-path", path: input.path }],
            limitations: [
              "Annotations are the selected decoder's interpretation of the recorded samples and caller-selected settings, not independently verified protocol semantics. Empty output does not establish absence of traffic.",
              "Sample-number ranges and display text are preserved verbatim, not converted to timestamps or parsed as a lossless byte stream. All producer stderr is retained, including warnings on exit zero.",
              "Only a private copy of the selected file is decoded. Hardware discovery/acquisition and target execution are not requested. Caller-supplied tools, plugins and decoder modules are trusted; this is not an OS sandbox.",
              "Linux prlimit enforces soft and hard ceilings before execution, preserving stricter inherited limits: at most 1 GiB address space per process, 64 MiB per file, 30 CPU seconds and no core dumps. Effective limits are reported. Resident input is capped at 32 MiB, each command at 30 wall-clock seconds and combined output at 4 MiB. Output overflow fails. These are per-process/per-file limits, not aggregate memory or filesystem quotas; caller-supplied tools and the limiter are trusted.",
            ],
          }),
        );
      }
    } catch (cause) {
      if (
        root !== undefined &&
        cause instanceof OwnedCommandFailure &&
        cause.cleanupOwner !== undefined
      )
        this.#resources.retain(root, cause.cleanupOwner);
      result = err(
        this.#failure(
          cause,
          phase,
          resourcePath,
          root?.path ?? null,
          effectiveLimits,
          capturedOutput,
          operation,
        ),
      );
    }
    return this.#resources.finish(
      result,
      (execution) =>
        createEvidence(execution.subject ?? undefined, execution.provider, {
          operation,
          parameters: input,
          result: execution.result,
          confidence: "observed",
          locations: execution.locations,
          limitations: execution.limitations,
        }),
      operation,
    );
  }
  #failure(
    cause: unknown,
    phase:
      | "configuration"
      | "artifact"
      | "workspace"
      | "producer"
      | "integrity",
    path: string,
    workspacePath: string | null,
    effectiveLimits: LinuxResourceLimits | undefined,
    observedOutput: AnalysisCapturedOutput | undefined,
    operation = OPERATION,
  ): AnalysisError {
    if (cause instanceof AnalysisError) return cause;
    if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
      return this.#resources.cleanupFailure(
        cause.cleanup,
        cause,
        observedOutput,
        operation,
      );
    if (
      (cause instanceof Error && cause.name === "AbortError") ||
      (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    )
      return new AnalysisCancelledError(operation, { cause });
    if (cause instanceof DecoderDiscoveryBudgetError)
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        cause.message,
        { line_budget: 65536 },
        {
          cause,
          ...(observedOutput === undefined
            ? {}
            : { capturedOutput: observedOutput }),
        },
      );
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof OwnedCommandFailure)
      return this.#resources.commandFailure(
        cause,
        LIMITS,
        effectiveLimits,
        operation,
      );
    if (phase === "workspace") {
      const code =
        cause instanceof Error &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : null;
      if (code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG")
        return new AnalysisResourceConstraintError(
          operation,
          "file-size",
          `Private analysis workspace failed (${code}): ${reason}`,
          { workspace_path: workspacePath, system_code: code },
          { cause },
        );
      return new ProviderAdapterError(SIGROK_PROVIDER_IDENTITY.id, operation, {
        cause,
        userMessage: `Cannot prepare the private analysis workspace: ${reason}`,
        diagnostics: {
          stage: "workspace",
          workspace_path: workspacePath,
          system_code: code,
          reason,
        },
      });
    }
    if (phase === "integrity") {
      const detail = {
        cause,
        ...(observedOutput === undefined
          ? {}
          : { capturedOutput: observedOutput }),
      };
      if (
        cause instanceof ArtifactReaderFailure &&
        ["limit", "integrity", "path"].includes(cause.reason)
      )
        return new AnalysisArtifactChangedError(
          operation,
          path,
          `Post-run identity verification failed for ${path}: ${reason}`,
          detail,
        );
      return new ProviderAdapterError(SIGROK_PROVIDER_IDENTITY.id, operation, {
        ...detail,
        diagnostics: { stage: "integrity", resource_path: path, reason },
      });
    }
    if (phase === "configuration")
      return new AnalysisCapabilityUnavailableError(
        SIGROK_PROVIDER_IDENTITY.id,
        operation,
        reason,
        {
          cause,
          ...(observedOutput === undefined
            ? {}
            : { capturedOutput: observedOutput }),
          userMessage: `${reason} On Linux, configure sigrok-cli 0.7.2 through REA_SIGROK_COMMAND and util-linux prlimit through REA_SIGROK_PRLIMIT_COMMAND (default /usr/bin/prlimit).`,
        },
      );
    if (
      phase === "artifact" &&
      cause instanceof ArtifactReaderFailure &&
      cause.reason === "limit"
    )
      return new AnalysisResourceConstraintError(
        operation,
        "file-size",
        reason,
        { input_bytes: LIMITS.input_bytes },
        { cause },
      );
    if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
      return new AnalysisArtifactChangedError(operation, path, reason, {
        cause,
      });
    if (
      phase === "artifact" &&
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "EACCES" || cause.code === "EPERM")
    )
      return new AnalysisAccessDeniedError(operation, path, cause.code, {
        cause,
      });
    if (phase === "artifact")
      return new AnalysisInputError(operation, { cause }, [
        { path: ["path"], reason: "invalid_value", message: reason },
      ]);
    return new AnalysisOutputError(operation, reason, {
      cause,
      ...(observedOutput === undefined
        ? {}
        : { capturedOutput: observedOutput }),
    });
  }
}
