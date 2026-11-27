import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import {
  readerIntegrityFailure,
  readStableArtifact,
} from "../resources/index.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import {
  recordingProducerFailureDialect,
  type RecordingProducerPhase,
} from "../providers/recordingProducerFailure.js";
import {
  BOUNDED_PRODUCER_LIMITS as LIMITS,
  producerLimitControl,
  resolveProducerLimits,
} from "../domain/producerResourceLimits.js";
import { TSHARK_PROVIDER_IDENTITY } from "./TsharkProviderIdentity.js";
import {
  producerOutputBytesLimit,
  resolveProducerOutputBytes,
} from "../config/producerOutputBytes.js";
import {
  type InspectPacketFieldsInput,
  PACKET_FIELD_PRODUCER_LIMITS,
  packetFieldsCatalogSchema,
} from "../domain/captures/packetFields.js";
import {
  parseFieldDiscovery,
  FIELD_RECORD_BUDGET,
} from "./parseFieldDiscovery.js";
import {
  prlimitArgumentVector,
  readLinuxResourceLimits,
  type LinuxResourceLimits,
} from "../process/LinuxResourceLimits.js";
import { parsePacketOutput } from "./parsePacketOutput.js";
import {
  capturePacketJsonExpansionError,
  resolveCapturePacketJsonExpansion,
} from "../config/capturePacketJsonExpansion.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../ports/AnalysisProvider.js";
import type { PacketCapturePort } from "../ports/captures/PacketCapturePort.js";
import {
  ARTIFACT_PRODUCER_LIMITATION,
  ArtifactAnalysisResources,
  type ArtifactAnalysisRuntime,
} from "../process/ArtifactAnalysisResources.js";
import { createArtifactAnalysisResources } from "../providers/artifactResourceFailure.js";
import {
  assertArtifactCommandPath,
  selectArtifactCommandPath,
} from "../process/ArtifactCommandPath.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisOutputError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  type InspectPacketCaptureInput,
  packetCaptureSchema,
} from "../domain/captures/packetCapture.js";
import { err, ok, type Result } from "../domain/result.js";
import { finalizedResult, runOwned } from "../providers/runOwned.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  TSHARK_COMMAND_ENV,
  assertWiresharkExecutableIdentity,
  wiresharkExecutableIdentity,
  locateWiresharkTool,
  parseWiresharkVersion,
  selectWiresharkTool,
} from "../pcap/PcapConfiguration.js";

const OPERATION = "inspect_packet_capture";

type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];

/** Packet inspection runs only on Linux; discovery and execution share this check. */
export const tsharkHostSupported = (platform: NodeJS.Platform): boolean =>
  platform === "linux";

/** Inspect selected capture files only, retaining cleanup ownership across failures. */
export class TsharkCaptureProvider implements PacketCapturePort {
  readonly #resources: ArtifactAnalysisResources;
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: Launcher,
    readonly createRuntime: () => Promise<ArtifactAnalysisRuntime> = () =>
      PrivateRuntimeRoot.create({ prefix: "rea-tshark-" }),
    readonly platform: NodeJS.Platform = HOST_PLATFORM.platform,
    readonly readArtifact: typeof readStableArtifact = readStableArtifact,
    readonly readLimits: typeof readLinuxResourceLimits = readLinuxResourceLimits,
  ) {
    this.#resources = createArtifactAnalysisResources(
      TSHARK_PROVIDER_IDENTITY.id,
      OPERATION,
      readArtifact,
      readLimits,
      {
        message:
          "A packet inspection is already active; retry after it completes.",
        details: { max_concurrent_inspections: 1 },
      },
    );
  }
  inspect(
    input: InspectPacketCaptureInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    return this.#resources.run(
      () => this.#executeRequest(input, options),
      options?.signal,
    );
  }
  inspectFields(
    input: InspectPacketFieldsInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    return this.#resources.run(
      () => this.#executeRequest(input, options),
      options?.signal,
      "inspect_packet_fields",
    );
  }
  close(): Promise<void> {
    return this.#resources.close();
  }
  async #executeRequest(
    input: InspectPacketCaptureInput | InspectPacketFieldsInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const operation = "path" in input ? OPERATION : "inspect_packet_fields";
    const defaults = "path" in input ? LIMITS : PACKET_FIELD_PRODUCER_LIMITS;
    // Capture shares the session-adjustable bounded-producer output budget;
    // the larger glossary default of field discovery stays per call.
    const output =
      "path" in input
        ? resolveProducerOutputBytes(
            input.producer_limits?.output_bytes,
            this.environment,
          )
        : undefined;
    // An invalid launch seed is refused inside the cleanup boundary below,
    // after retained cleanup is retried.
    const limits = resolveProducerLimits(defaults, {
      ...input.producer_limits,
      ...(output?.ok === true ? { output_bytes: output.value.value } : {}),
    });
    const outputControl =
      output?.ok !== true
        ? producerLimitControl(
            "output_bytes",
            limits.output_bytes,
            defaults.output_bytes,
          )
        : producerOutputBytesLimit(output.value);
    let phase: RecordingProducerPhase = "configuration";
    let capturedOutput: AnalysisCapturedOutput | undefined;
    let resourcePath = "path" in input ? input.path : "TShark field glossary";
    let effectiveLimits: LinuxResourceLimits | undefined;
    let root: ArtifactAnalysisRuntime | undefined;
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted)
        throw cancelledBy(operation, options.signal);
      await this.#resources.release();
      if (output?.ok === false) throw output.error;
      if (!tsharkHostSupported(this.platform))
        throw new Error(
          "Packet inspection requires Linux with util-linux prlimit and TShark 4.x (on PATH or through absolute REA_TSHARK_COMMAND) so expanded captures are processed under an enforced address-space limit.",
        );
      const selection = selectWiresharkTool(this.environment, "tshark");
      const configured = locateWiresharkTool(selection, this.environment);
      if (configured === undefined)
        throw new Error(
          `TShark 4.x was not found on PATH; add it to PATH or set absolute ${TSHARK_COMMAND_ENV}.`,
        );
      const selectedCommand = await selectArtifactCommandPath(
        configured,
        options?.signal,
      );
      const command = selectedCommand.resolvedPath;
      await access(command, constants.X_OK);
      const toolSnapshot = await this.#resources.hash(
        command,
        64 * 1024 * 1024,
        options?.signal,
      );
      const tool = wiresharkExecutableIdentity(toolSnapshot);
      const configuredLimiter =
        this.environment.REA_TSHARK_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";
      if (!isAbsolute(configuredLimiter))
        throw new Error("REA_TSHARK_PRLIMIT_COMMAND must be absolute.");
      const selectedLimiter = await selectArtifactCommandPath(
        configuredLimiter,
        options?.signal,
      );
      const limiter = selectedLimiter.resolvedPath;
      await access(limiter, constants.X_OK);
      const limiterIdentity = await this.#resources.hash(
        limiter,
        64 * 1024 * 1024,
        options?.signal,
      );
      effectiveLimits = await this.#resources.readLimits(limits);
      const limitArguments = prlimitArgumentVector(
        effectiveLimits,
        selectedCommand.invocationPath,
      );
      phase = "workspace";
      root = await this.createRuntime();
      this.#resources.retain(root, undefined);
      const snapshotPath = join(root.path, "capture");
      const configurationPath = join(root.path, "configuration");
      await mkdir(configurationPath, { mode: 0o700 });
      const execute = async (args: readonly string[]) => {
        capturedOutput = undefined;
        await assertArtifactCommandPath(selectedCommand, operation, {
          signal: options?.signal,
        });
        await assertArtifactCommandPath(selectedLimiter, operation, {
          signal: options?.signal,
        });
        const output = await runOwnedCommand(
          {
            command: selectedLimiter.invocationPath,
            arguments: [...limitArguments, ...args],
            ...(root === undefined ? {} : { cwd: root.path }),
            expectedCommand: null,
            runId: `rea-tshark-${randomUUID()}`,
            hostEnvironment: {
              ...this.environment,
              WIRESHARK_CONFIG_DIR: configurationPath,
            },
          },
          {
            timeoutMs: limits.command_timeout_ms,
            diagnosticBytes: limits.output_bytes,
            acceptNonZeroExit: true,
          },
          {
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
            ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
          },
        );
        capturedOutput = capturedProviderOutput(output);
        await assertArtifactCommandPath(selectedCommand, operation, {
          capturedOutput,
        });
        await assertArtifactCommandPath(selectedLimiter, operation, {
          capturedOutput,
        });
        const current = await this.#resources.readCommandAfterRun(
          command,
          { path: limiter, sha256: limiterIdentity.sha256 },
          capturedOutput,
          operation,
        );
        assertWiresharkExecutableIdentity(
          operation,
          command,
          tool,
          wiresharkExecutableIdentity(current),
          { capturedOutput },
        );
        resourcePath = "path" in input ? input.path : command;
        if (output.exitCode !== 0)
          throw new ProviderAdapterError(
            TSHARK_PROVIDER_IDENTITY.id,
            operation,
            {
              diagnostics: {
                exit_code: capturedOutput.exit_code ?? null,
                stdout: capturedOutput.stdout,
                stderr: capturedOutput.stderr,
              },
            },
          );
        const invalidUtf8Streams = [
          ...(output.stdout.invalidUtf8 ? ["stdout"] : []),
          ...(output.stderr.invalidUtf8 ? ["stderr"] : []),
        ];
        if (invalidUtf8Streams.length > 0)
          throw new AnalysisOutputError(
            operation,
            "TShark output is not valid UTF-8; retained text contains replacement characters.",
            {
              capturedOutput,
              diagnostics: {
                stage: phase,
                invalid_utf8_streams: invalidUtf8Streams,
              },
            },
          );
        return output;
      };
      phase = "configuration";
      const version = await execute(["--version"]);
      if (parseWiresharkVersion(version.stdout.text, "tshark") === null)
        throw new Error(
          "Expected TShark 4.x; inspect the selected installation.",
        );
      const metadata = (args: readonly string[], diagnostics: string) => ({
        diagnostics,
        tool: {
          configured_path: configured,
          selection_source: selection.source,
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
        limits: { ...limits, ...effectiveLimits },
        hardware_acquisition: "not-performed" as const,
      });
      if (!("path" in input)) {
        phase = "producer";
        const args = ["-G", "fields"];
        const output = await execute(args);
        const report = packetFieldsCatalogSchema.parse({
          selection: input,
          ...parseFieldDiscovery(output.stdout.text, input),
          ...metadata(args, output.stderr.text),
          limits: {
            ...limits,
            ...effectiveLimits,
            record_budget_bytes: FIELD_RECORD_BUDGET,
          },
          configuration: "private-empty-personal-profile",
        });
        result = ok(
          createAnalysisExecution(report, TSHARK_PROVIDER_IDENTITY, {
            subject: { path: command, sha256: tool.sha256, format: "file" },
            limitations: [
              "Protocol and field registrations describe the selected installation, not traffic observed in a capture. Duplicate abbreviations remain distinct producer records with source line numbers.",
              "Each request probes again without caching. The private empty personal profile does not fingerprint or isolate installed libraries, global configuration or plugins; they remain trusted.",
              "No capture file, interface or device is opened. Resource ceilings do not constitute an OS sandbox. Selected producer output budget is reported in limits.output_bytes and can be changed with producer_limits.output_bytes. Selected record representation remains independently capped at 8 MiB before expansion.",
            ],
          }),
        );
      } else {
        const expansion = resolveCapturePacketJsonExpansion(this.environment);
        if (!expansion.ok) throw expansion.error;
        const selected = await this.#resources.readSelectedArtifact({
          path: input.path,
          budget: producerLimitControl(
            "input_bytes",
            limits.input_bytes,
            LIMITS.input_bytes,
          ),
          observedOutput: capturedOutput,
          signal: options?.signal,
        });
        phase = "workspace";
        await writeFile(snapshotPath, selected.bytes, {
          flag: "wx",
          mode: 0o400,
        });
        phase = "producer";
        const args = [
          "-n",
          "-r",
          "capture",
          "-T",
          "json",
          "--no-duplicate-keys",
          "--temp-dir=.",
          ...(input.two_pass ? ["-2"] : []),
          ...(input.packet_limit === null
            ? []
            : ["-c", String(input.packet_limit)]),
          ...(input.display_filter === null
            ? []
            : ["-Y", input.display_filter]),
          ...input.decode_as.flatMap((value) => ["-d", value]),
          ...[...new Set(["frame.number", ...input.fields])].flatMap(
            (field) => ["-e", field],
          ),
        ];
        const output = await execute(args);
        phase = "integrity";
        resourcePath = snapshotPath;
        if (
          (await this.#resources.hash(snapshotPath, limits.input_bytes))
            .sha256 !== selected.sha256
        )
          throw new AnalysisArtifactChangedError(
            operation,
            snapshotPath,
            "TShark changed the private capture copy.",
            capturedOutput === undefined ? {} : { capturedOutput },
          );
        phase = "producer";
        resourcePath = "path" in input ? input.path : command;
        // TShark resolves `-e` aliases before emitting canonical field names;
        // the command arguments, not output names, own field selection.
        const parsedPackets = await parsePacketOutput(
          output.stdout.text,
          input.packet_limit,
          {
            outputBytes: limits.output_bytes,
            expansionBytes: expansion.value.maximumBytes,
          },
        );
        if (!parsedPackets.ok) {
          const failure = parsedPackets.error;
          if (failure.kind === "expansion")
            throw capturePacketJsonExpansionError(
              operation,
              expansion.value,
              capturedOutput,
            );
          throw new AnalysisOutputError(operation, failure.reason, {
            ...(failure.cause === undefined ? {} : { cause: failure.cause }),
            ...(capturedOutput === undefined ? {} : { capturedOutput }),
          });
        }
        const matchingPackets = parsedPackets.value;
        const start = Math.min(input.match_offset, matchingPackets.length);
        const end =
          input.match_limit === null
            ? matchingPackets.length
            : start +
              Math.min(input.match_limit, matchingPackets.length - start);
        const packets = matchingPackets.slice(start, end);
        const report = packetCaptureSchema.parse({
          artifact: {
            path: input.path,
            sha256: selected.sha256,
            bytes: selected.bytes.length,
          },
          selection: input,
          packets,
          output_window: {
            matching_packets: matchingPackets.length,
            returned_packets: packets.length,
            has_more: end < matchingPackets.length,
          },
          read_scope:
            input.packet_limit === null ? "to-eof" : "up-to-input-packet-limit",
          configuration: "private-empty-personal-profile",
          ...metadata(args, output.stderr.text),
        });
        result = ok(
          createAnalysisExecution(report, TSHARK_PROVIDER_IDENTITY, {
            subject: {
              path: input.path,
              sha256: selected.sha256,
              format: "file",
            },
            locations: [{ kind: "artifact-path", path: input.path }],
            limitations: [
              "Fields are TShark dissector observations under the selected filter/decode-as/pass settings, not independently verified protocol semantics. Missing fields are absent from the producer output, not known zero or empty values.",
              "Packet limits count input packets before display filtering. Filtered results do not establish whole-capture or device traffic absence. Two-pass reassembly cannot recover bytes missing from the recording or beyond the read limit.",
              "Repeated field values remain ordered string arrays; raw packet bytes are included only when explicitly selected as a supported field. Export index/score metadata are omitted. All stderr, including warnings on exit zero, is retained.",
              "A private empty personal configuration is used. Installed libraries, global configuration and dissector plugins are trusted and not fully fingerprinted. File-only analysis and disabled name resolution do not constitute an OS sandbox.",
              ARTIFACT_PRODUCER_LIMITATION,
            ],
          }),
        );
      }
    } catch (cause) {
      this.#resources.retainCommandCleanup(root, cause);
      const dialect = recordingProducerFailureDialect(this.#resources, {
        operation,
        phase,
        path: resourcePath,
        workspacePath: root?.path ?? null,
        limits: { selected: limits, defaults, output: outputControl },
        effectiveLimits,
        observedOutput: capturedOutput,
        configurationHelp:
          "On Linux, supply TShark 4.x on PATH or through absolute REA_TSHARK_COMMAND, and util-linux prlimit through REA_TSHARK_PRLIMIT_COMMAND (default /usr/bin/prlimit).",
        readerIntegrity: (failure) =>
          readerIntegrityFailure(operation, resourcePath, failure),
      });
      result = err(classifyProviderFailure(cause, dialect));
    }
    const completed = result;
    return finalizedResult(
      await runOwned(async () => completed, {
        providerId: this.#resources.providerId,
        operation,
        signal: options?.signal,
        close: () => this.#resources.release(),
        partial: (execution) =>
          createAnalysisExecutionEvidence(
            operation,
            input,
            execution,
            "observed",
          ),
      }),
    );
  }
}
