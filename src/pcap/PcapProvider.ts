import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import { PCAP_PROVIDER_IDENTITY } from "./PcapProviderIdentity.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { PCAP_HTTP_URI_FIELDS } from "./PcapHttpUri.js";
import {
  type ExecutionOptions,
  type ProviderAvailability,
  createAnalysisExecution,
  type AnalysisExecution,
} from "../ports/AnalysisProvider.js";
import {
  pcapResultSchemas,
  PCAP_CAPTURE_HOST_REMEDIATION,
  pcapCaptureHostSupported,
  type PcapRequest,
  type PcapOperation,
} from "../domain/pcap/pcapAnalysis.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisCleanupReleaseClaim,
} from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  PcapConfigurationFailure,
  assertWiresharkExecutableIdentity,
  inspectPcapClient,
  locateWiresharkTool,
  resolvePcapTools,
  pcapConfigurationAvailability,
  PCAP_TOOL_REMEDIATION,
  pcapToolUnavailable,
  wiresharkExecutableIdentity,
  type PcapToolSelection,
  type WiresharkExecutableIdentity,
} from "./PcapConfiguration.js";
import {
  parseCapinfosOutput,
  parseTsharkJsonOutput,
  TSHARK_JSON_MAX_BYTES,
} from "./PcapOutput.js";
import {
  runPcapCommand,
  type PcapCommandCleanup,
  type PcapCommandOutput,
  type PcapCommandLimits,
  type PcapCommandLauncher,
} from "./PcapCommand.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { UnclassifiedProviderFailure } from "../domain/unclassifiedProviderFailure.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { createPcapEvidence } from "../domain/pcap/pcapEvidence.js";
import { preparePcapNativeBound } from "./PcapNativeBound.js";
import { PcapSnapshot } from "./PcapSnapshot.js";
import {
  readStableArtifact,
  ArtifactReaderFailure,
} from "../resources/index.js";
import { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import { createArtifactAnalysisResources } from "../providers/artifactResourceFailure.js";
import { readLinuxResourceLimits } from "../process/LinuxResourceLimits.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  assertArtifactCommandPath,
  selectArtifactCommandPath,
  type ArtifactCommandPath,
} from "../process/ArtifactCommandPath.js";
import { errorMessage } from "../kernel/errorMessage.js";

const FIELDS = [
  "frame.number",
  "frame.protocols",
  "ip.src",
  "ip.dst",
  "ipv6.src",
  "ipv6.dst",
  "dns.flags.response",
  "dns.qry.name",
  "dns.qry.type",
  "dns.qry.class",
  "dns.count.queries",
  "dns.count.answers",
  "dns.count.auth_rr",
  "dns.count.add_rr",
  "dns.resp.name",
  "dns.resp.type",
  "dns.resp.class",
  "dns.cname",
  "dns.a",
  "dns.aaaa",
  "tls.handshake.extensions_server_name",
  ...Object.keys(PCAP_HTTP_URI_FIELDS),
  "http2.headers.path",
];

const pcapPartialEvidence = (
  request: PcapRequest,
  provider:
    | typeof PCAP_PROVIDER_IDENTITY
    | {
        readonly id: string;
        readonly name: string;
        readonly version: string | null;
      },
  path: string,
  identity: { readonly bytes: number; readonly sha256: string },
  result: unknown,
  limitations: readonly string[],
) =>
  createPcapEvidence(request, {
    subject: { path, format: "file", sha256: identity.sha256 },
    provider,
    result: jsonValueSchema.parse(result),
    rawResult: null,
    limitations,
    locations: [{ kind: "artifact-path", path }],
  });

/** Completed Pcap output whose only failure is its retained command cleanup. */
class PcapCommandCleanupError extends ProviderCleanupError {}

/** Report a probe whose owned command still needs cleanup after it returned. */
const probeCleanupFailure = (
  operation: PcapOperation,
  cleanup: PcapCommandCleanup,
  output: AnalysisCapturedOutput,
): ProviderCleanupError =>
  new ProviderCleanupError(
    "pcap",
    cleanup.resources,
    {
      reason: cleanup.reason,
      previous_error: null,
      captured_output: {
        ...output,
      },
    },
    { operation },
  );

const pcapCommandCleanupError = (
  operation: PcapOperation,
  snapshotPath: string | undefined,
  cleanup: PcapCommandCleanup,
  capturedOutput: AnalysisCapturedOutput,
  partialObservation?: ReturnType<typeof pcapPartialEvidence>,
) =>
  new PcapCommandCleanupError(
    "pcap",
    [
      ...new Set([
        ...(snapshotPath === undefined ? [] : [snapshotPath]),
        ...cleanup.resources,
      ]),
    ],
    {
      reason: cleanup.reason,
      previous_error: null,
      captured_output: {
        ...capturedOutput,
      },
    },
    {
      operation,
      ...(partialObservation === undefined ? {} : { partialObservation }),
    },
  );

const assertValidPcapCommandText = (
  operation: PcapOperation,
  stage: "version" | "capinfos" | "tshark",
  output: Awaited<ReturnType<typeof runPcapCommand>>,
): void => {
  if (output.invalidUtf8Streams.length === 0) return;
  throw new AnalysisOutputError(
    operation,
    `${stage} output is not valid UTF-8; retained text contains replacement characters.`,
    {
      get capturedOutput() {
        return output.capturedOutput;
      },
      diagnostics: {
        stage,
        invalid_utf8_streams: [...output.invalidUtf8Streams],
      },
    },
  );
};

/**
 * What the failed DNS wire pass reported. An unrecognised command outcome
 * names its stage in `detail`, or else the examined outcome's reason.
 */
const dnsFailureReason = (cause: AnalysisError): string => {
  if (!(cause instanceof UnclassifiedProviderFailure)) return cause.message;
  const detail = cause.diagnostics?.detail;
  return typeof detail === "string" ? detail : cause.examined.reason;
};

export interface PcapProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly launcher?: PcapCommandLauncher;
  readonly artifactReader?: typeof readStableArtifact;
  /** The host the packet tools run on; defaults to the running host. */
  readonly platform?: NodeJS.Platform;
}

/**
 * One command whose process-family release is unconfirmed. Errors that report
 * it read the release when asked; it is never pushed to them.
 */
class RetainedPcapCommand implements AnalysisCleanupReleaseClaim {
  #failure: AnalysisError | undefined;
  #released = false;

  constructor(
    readonly snapshot: PcapSnapshot | undefined,
    readonly resources: readonly string[],
    readonly reason: string,
    readonly capturedOutput: PcapCommandCleanup["capturedOutput"],
  ) {}

  get cleanupReleased(): boolean {
    return this.#released;
  }

  /** The latest error reporting this command's retained cleanup. */
  get failure(): AnalysisError | undefined {
    return this.#failure;
  }

  retainFailure<T extends AnalysisError>(failure: T): T {
    this.#failure = failure.bindCleanupReleaseClaim(this);
    return failure;
  }

  confirmReleased(): void {
    this.#released = true;
  }
}

/** Errors reporting one snapshot, complete once the snapshot closes. */
class RetainedSnapshotFailure implements AnalysisCleanupReleaseClaim {
  #released = false;

  constructor(
    /** Exact error returned to the caller for the originating analysis. */
    readonly returned: AnalysisError,
    /** Snapshot-owned failure completed only by a successful snapshot close. */
    readonly snapshot: AnalysisError,
  ) {
    returned.bindCleanupReleaseClaim(this);
    snapshot.bindCleanupReleaseClaim(this);
  }

  get cleanupReleased(): boolean {
    return this.#released;
  }

  confirmReleased(): void {
    this.#released = true;
  }
}

/** Inspect saved captures through bounded, owned tool processes and one stable input copy. */
export class PcapProvider {
  readonly #resources: ArtifactAnalysisResources;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly launcher: PcapCommandLauncher | undefined;
  private readonly wiresharkIdentities = new Map<
    string,
    ArtifactCommandPath & { readonly identity: WiresharkExecutableIdentity }
  >();
  private readonly platform: NodeJS.Platform;
  private readonly snapshots = new Set<PcapSnapshot>();
  private readonly snapshotFailures = new Map<
    PcapSnapshot,
    RetainedSnapshotFailure
  >();
  private readonly commands = new Map<
    ProviderProcessSupervisor,
    RetainedPcapCommand
  >();

  constructor(options: PcapProviderOptions = {}) {
    this.platform = options.platform ?? HOST_PLATFORM.platform;
    this.environment = snapshotEnvironment(
      options.environment ?? process.env,
      this.platform,
    );
    this.launcher = options.launcher;
    this.#resources = createArtifactAnalysisResources(
      "pcap",
      "inspect_pcap_capture",
      options.artifactReader ?? readStableArtifact,
      readLinuxResourceLimits,
      {
        message:
          "A packet summary is already active; retry after it completes.",
        details: { max_concurrent_inspections: 1 },
      },
    );
  }

  /** Selected-tool reads are configuration admission, independently of capture bytes. */
  private async readToolIdentity(
    operation: PcapOperation,
    path: string,
    signal?: AbortSignal,
  ) {
    try {
      return await this.#resources.read(path, 64 * 1024 * 1024, signal);
    } catch (cause) {
      // The caller reports a cancelled read as the request's cancellation.
      if (
        cause instanceof ArtifactReaderFailure &&
        cause.reason === "cancelled"
      )
        throw cause;
      throw classifyProviderFailure(cause, {
        ...this.#failureDialect(operation),
        unclassified: (failure) =>
          pcapToolUnavailable(
            operation,
            `Cannot read selected Wireshark tool ${path}: ${errorMessage(failure)}`,
            { cause: failure },
          ),
      });
    }
  }

  private async run(
    operation: PcapOperation,
    stage: "version" | "capinfos" | "tshark",
    command: string,
    args: readonly string[],
    limits: PcapCommandLimits,
    signal: AbortSignal | undefined,
    snapshot?: PcapSnapshot,
    inputPath?: string,
  ) {
    let cleanup: PcapCommandCleanup | undefined;
    let retainedCommand: RetainedPcapCommand | undefined;
    let output: Awaited<ReturnType<typeof runPcapCommand>>;
    let commandReturned = false;
    const selected = this.wiresharkIdentities.get(command);
    try {
      if (selected !== undefined) {
        await assertArtifactCommandPath(selected, operation, { signal });
        const before = await this.readToolIdentity(
          operation,
          selected.resolvedPath,
          signal,
        );
        assertWiresharkExecutableIdentity(
          operation,
          selected.resolvedPath,
          selected.identity,
          wiresharkExecutableIdentity(before),
        );
      }
      output = await runPcapCommand({
        operation,
        platform: this.platform,
        redactHttpTransportCredentials:
          stage === "tshark" && operation === "inspect_pcap_capture",
        command: selected?.invocationPath ?? command,
        arguments: args,
        limits,
        signal,
        environment:
          snapshot === undefined
            ? this.environment
            : {
                ...this.environment,
                WIRESHARK_CONFIG_DIR: snapshot.configurationPath,
              },
        ...(inputPath === undefined ? {} : { inputPath }),
        ...(inputPath === undefined || this.nativeBound === undefined
          ? {}
          : { nativeBound: this.nativeBound }),
        ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
        retain: (owner, resources, reason, capturedOutput) => {
          retainedCommand = new RetainedPcapCommand(
            snapshot,
            resources,
            reason,
            capturedOutput,
          );
          this.commands.set(owner, retainedCommand);
          cleanup = { reason, resources, capturedOutput };
        },
      });
      commandReturned = true;
      if (selected !== undefined) {
        await assertArtifactCommandPath(selected, operation, {
          get capturedOutput() {
            return output.capturedOutput;
          },
        });
        const after = await this.readToolIdentity(
          operation,
          selected.resolvedPath,
        );
        assertWiresharkExecutableIdentity(
          operation,
          selected.resolvedPath,
          selected.identity,
          wiresharkExecutableIdentity(after),
          {
            get capturedOutput() {
              return output.capturedOutput;
            },
          },
        );
      }
      assertValidPcapCommandText(operation, stage, output);
    } catch (cause) {
      if (
        !commandReturned &&
        retainedCommand !== undefined &&
        cause instanceof AnalysisError &&
        cause.cleanupIncomplete
      ) {
        throw retainedCommand.retainFailure(cause);
      }
      // Post-run validation can fail before the caller receives the command
      // output. Carry its retained cleanup for both probes and capture reads.
      if (commandReturned && cleanup !== undefined) {
        const pending =
          inputPath === undefined
            ? probeCleanupFailure(operation, cleanup, cleanup.capturedOutput)
            : pcapCommandCleanupError(
                operation,
                snapshot?.path,
                cleanup,
                cleanup.capturedOutput,
              );
        retainedCommand?.retainFailure(pending);
        // The classified failure may own its own cleanup, such as an
        // executable re-read whose file close failed; keep both live.
        const primary = classifyProviderFailure(
          cause,
          this.#failureDialect(operation),
        );
        throw analysisErrorWithCleanupFailure(
          primary,
          pending,
          operation,
        ).bindCleanupDependencies([primary, pending]);
      }
      throw cause;
    }
    if (inputPath === undefined && cleanup !== undefined) {
      const failure = probeCleanupFailure(
        operation,
        cleanup,
        output.capturedOutput,
      );
      retainedCommand?.retainFailure(failure);
      throw failure;
    }
    return output;
  }

  private nativeBound: Parameters<typeof runPcapCommand>[0]["nativeBound"];
  private nativeLimitations: readonly string[] = [];

  private async prepareCaptureBound(
    operation: PcapOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    const prepared = await preparePcapNativeBound(
      this.platform,
      this.environment,
      this.#resources,
      async (selected, arguments_) => {
        await assertArtifactCommandPath(selected, operation, { signal });
        const output = await this.run(
          operation,
          "version",
          selected.invocationPath,
          arguments_,
          { timeoutMs: 20_000, maxOutputBytes: 64 * 1024 },
          signal,
        );
        await assertArtifactCommandPath(selected, operation, { signal });
        return output;
      },
      signal,
      operation,
    );
    this.nativeBound = prepared.nativeBound;
    this.nativeLimitations = prepared.limitations;
  }

  private async client(operation: PcapOperation, signal?: AbortSignal) {
    const selection = resolvePcapTools(this.environment, this.platform);
    this.wiresharkIdentities.clear();
    for (const [name, selected] of [
      ["tshark", selection.tshark],
      ["capinfos", selection.capinfos],
    ] as const) {
      const path = locateWiresharkTool(selected, this.environment);
      if (path === undefined) continue;
      let commandPath: ArtifactCommandPath;
      try {
        commandPath = await selectArtifactCommandPath(path, signal);
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          (cause.code === "ENOENT" || cause.code === "ENOTDIR")
        )
          throw new PcapConfigurationFailure(
            `${name}_missing`,
            `The selected ${name} executable ${selected.command} could not be found at its configured path.`,
            { command: selected.command },
            { cause },
          );
        throw cause;
      }
      const snapshot = await this.readToolIdentity(
        operation,
        commandPath.resolvedPath,
        signal,
      );
      this.wiresharkIdentities.set(selected.command, {
        ...commandPath,
        identity: wiresharkExecutableIdentity(snapshot),
      });
    }
    const identity = await inspectPcapClient(
      selection,
      async (command) =>
        (
          await this.run(
            operation,
            "version",
            command,
            ["--version"],
            { timeoutMs: 20_000, maxOutputBytes: 64 * 1024 },
            signal,
          )
        ).stdout,
    );
    for (const [name, version] of [
      ["tshark", identity.tsharkVersion],
      ["capinfos", identity.capinfosVersion],
    ] as const) {
      if (version === null)
        throw new PcapConfigurationFailure(
          `${name}_version_unresolved`,
          `The selected ${name} command did not report a version. Set REA_${name.toUpperCase()}_COMMAND to its absolute executable path.`,
        );
    }
    return {
      selection,
      client: {
        tshark_command: selection.tshark.command,
        tshark_source: selection.tshark.source,
        tshark_version: identity.tsharkVersion,
        tshark_resolved_path:
          this.wiresharkIdentities.get(selection.tshark.command)
            ?.resolvedPath ?? null,
        tshark_sha256:
          this.wiresharkIdentities.get(selection.tshark.command)?.identity
            .sha256 ?? null,
        tshark_identity_status: this.wiresharkIdentities.has(
          selection.tshark.command,
        )
          ? "verified"
          : "unresolved",
        capinfos_command: selection.capinfos.command,
        capinfos_source: selection.capinfos.source,
        capinfos_version: identity.capinfosVersion,
        capinfos_resolved_path:
          this.wiresharkIdentities.get(selection.capinfos.command)
            ?.resolvedPath ?? null,
        capinfos_sha256:
          this.wiresharkIdentities.get(selection.capinfos.command)?.identity
            .sha256 ?? null,
        capinfos_identity_status: this.wiresharkIdentities.has(
          selection.capinfos.command,
        )
          ? "verified"
          : "unresolved",
      },
    };
  }

  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    const result = await this.#resources.run(async () => {
      const cleanup = this.pendingCleanupFailure("inspect_pcap_client");
      if (cleanup !== undefined) throw cleanup;
      return ok(await this.inspectAvailabilityAdmitted(signal));
    }, signal);
    if (!result.ok) throw result.error;
    return result.value;
  }

  private async inspectAvailabilityAdmitted(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    try {
      const { client } = await this.client("inspect_pcap_client", signal);
      if (!pcapCaptureHostSupported(this.platform))
        return {
          status: "unavailable",
          code: "unsupported_host",
          reason:
            "No enforceable native memory boundary is available for capture summaries on this host.",
          remediation: PCAP_CAPTURE_HOST_REMEDIATION,
          diagnostics: client,
        };
      await this.prepareCaptureBound("inspect_pcap_client", signal);
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: client,
      };
    } catch (cause) {
      if (
        (cause instanceof AnalysisError && cause.cleanupIncomplete) ||
        cause instanceof AnalysisCancelledError
      )
        throw cause;
      if (cause instanceof PcapConfigurationFailure)
        return pcapConfigurationAvailability(cause);
      return {
        status: "unavailable",
        code:
          cause instanceof AnalysisCapabilityUnavailableError
            ? "executable_missing"
            : "version_unresolved",
        reason: errorMessage(cause),
        // Keep the failing owner's repair, such as the limiter's; only an
        // unattributed tool failure falls back to the Wireshark guidance.
        remediation:
          (cause instanceof AnalysisCapabilityUnavailableError
            ? cause.remediationAction
            : undefined) ?? PCAP_TOOL_REMEDIATION,
        diagnostics: {},
      };
    }
  }

  private async discard(
    snapshot: PcapSnapshot,
  ): Promise<AnalysisError | undefined> {
    try {
      if (
        [...this.commands.values()].some(
          (command) =>
            command.snapshot === snapshot && !command.cleanupReleased,
        )
      )
        throw new Error(
          "An unreleased command still owns the capture snapshot",
        );
      await snapshot.close();
      this.snapshots.delete(snapshot);
      this.snapshotFailures.get(snapshot)?.confirmReleased();
      this.snapshotFailures.delete(snapshot);
      return undefined;
    } catch (cause) {
      return new ProviderCleanupError(
        "pcap",
        [snapshot.path],
        { reason: String(cause) },
        { operation: "inspect_pcap_capture", cause },
      );
    }
  }

  /** Refuse new work while a prior command or snapshot still has a cleanup owner. */
  private pendingCleanupFailure(
    operation: string,
  ): ProviderCleanupError | undefined {
    const retainedCommands = [...this.commands.values()].filter(
      (command) => !command.cleanupReleased,
    );
    if (retainedCommands.length === 0 && this.snapshots.size === 0)
      return undefined;
    const dependencies = [
      ...retainedCommands.flatMap((command) =>
        command.failure === undefined ? [] : [command.failure],
      ),
      ...[...this.snapshotFailures.values()].map(({ snapshot }) => snapshot),
    ];
    return new ProviderCleanupError(
      "pcap",
      [
        ...[...this.snapshots].map((snapshot) => snapshot.path),
        ...retainedCommands.flatMap((command) => command.resources),
      ],
      { reason: "Previous packet-capture resources remain owned." },
      { operation },
    ).bindCleanupDependencies(dependencies);
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    let artifactCleanupFailure: AnalysisError | undefined;
    try {
      await this.#resources.close();
    } catch (cause) {
      failures.push(cause);
      if (cause instanceof AnalysisError && cause.cleanupIncomplete)
        artifactCleanupFailure = cause;
    }
    for (const [owner, command] of this.commands) {
      if (command.cleanupReleased) continue;
      if (command.failure === undefined)
        command.retainFailure(
          new ProviderCleanupError(
            "pcap",
            command.resources,
            { reason: command.reason },
            { operation: "pcap.close" },
          ),
        );
      try {
        const result = await owner.stop();
        if (result.status === "incomplete") failures.push(result.reason);
        else if (result.status === "not-owned")
          failures.push("Command ownership remains unresolved");
        else {
          command.confirmReleased();
          if (command.snapshot === undefined) {
            this.commands.delete(owner);
          }
        }
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const snapshot of this.snapshots) {
      if (this.snapshotFailures.has(snapshot)) continue;
      const failure = new ProviderCleanupError(
        "pcap",
        [snapshot.path],
        { reason: "Capture snapshot cleanup remains unresolved." },
        { operation: "pcap.close" },
      );
      this.snapshotFailures.set(
        snapshot,
        new RetainedSnapshotFailure(failure, failure),
      );
    }
    for (const snapshot of this.snapshots) {
      const failure = await this.discard(snapshot);
      if (failure !== undefined) {
        failures.push(failure);
      } else {
        for (const [owner, command] of this.commands) {
          if (command.snapshot !== snapshot) continue;
          this.commands.delete(owner);
        }
      }
    }
    if (failures.length > 0) {
      const cleanup = new ProviderCleanupError(
        "pcap",
        [
          ...(artifactCleanupFailure?.cleanupResources ?? []),
          ...[...this.snapshots]
            .map((snapshot) => snapshot.path)
            .concat(
              [...this.commands.values()]
                .filter((command) => !command.cleanupReleased)
                .flatMap((command) => command.resources),
            ),
        ],
        { reason: "Owned process or snapshot cleanup failed" },
        { operation: "pcap.close", cause: new AggregateError(failures) },
      );
      const dependencies = [
        ...(artifactCleanupFailure === undefined
          ? []
          : [artifactCleanupFailure]),
        ...[...this.commands.values()]
          .filter((command) => !command.cleanupReleased)
          .flatMap((command) =>
            command.failure === undefined ? [] : [command.failure],
          ),
        ...[...this.snapshotFailures.values()].map(({ snapshot }) => snapshot),
      ];
      if (dependencies.length > 0)
        cleanup.bindCleanupDependencies([...new Set(dependencies)]);
      throw cleanup;
    }
  }

  async execute(
    request: PcapRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    return this.#resources.run(() => {
      const cleanup = this.pendingCleanupFailure(request.operation);
      return cleanup === undefined
        ? this.executeAdmitted(request, options)
        : Promise.resolve(err(cleanup));
    }, options?.signal);
  }

  /** The pcap dialect for the shared provider failure classifier. */
  #failureDialect(operation: PcapOperation): ProviderFailureDialect {
    return {
      providerId: PCAP_PROVIDER_IDENTITY.id,
      operation,
      recognise: (cause) =>
        cause instanceof PcapConfigurationFailure
          ? pcapToolUnavailable(operation, cause.message, {
              cause,
              diagnostics: cause.diagnostics,
            })
          : undefined,
      readCleanup: (read, primary) =>
        this.#resources.readCleanupFailure(read, primary, undefined, operation),
      unclassified: (cause) =>
        new AnalysisProtocolError(
          `Packet-capture analysis failed: ${errorMessage(cause)}`,
          { cause },
        ),
    };
  }

  private async executeAdmitted(
    request: PcapRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const signal = options?.signal;
    let snapshot: PcapSnapshot | undefined;
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (signal?.aborted) throw cancelledBy(request.operation, signal);
      const { selection, client } = await this.client(
        request.operation,
        signal,
      );
      const provider = {
        ...PCAP_PROVIDER_IDENTITY,
        version: client.tshark_version,
      };
      if (request.operation === "inspect_pcap_client")
        result = ok(
          createAnalysisExecution(
            pcapResultSchemas.inspect_pcap_client.parse({ client }),
            provider,
          ),
        );
      else {
        await this.prepareCaptureBound(request.operation, signal);
        snapshot = await PcapSnapshot.create();
        this.snapshots.add(snapshot);
        const identity = await snapshot.capture(request.input.path, signal);
        const captured = await this.inspectCapture(
          selection,
          snapshot,
          request.input.path,
          identity,
          signal,
          request,
          provider,
          client,
        );
        const data = pcapResultSchemas.inspect_pcap_capture.parse({
          client,
          ...captured.result,
        });
        result = ok(
          createAnalysisExecution(data, provider, {
            subject: {
              path: request.input.path,
              format: "file",
              sha256: identity.sha256,
            },
            limitations: captured.limitations,
          }),
        );
      }
    } catch (cause) {
      result = err(
        classifyProviderFailure(cause, this.#failureDialect(request.operation)),
      );
    }
    if (signal?.aborted && result.ok)
      result = err(
        cancelledBy(request.operation, signal, {
          partialObservation: createPcapEvidence(request, result.value),
        }),
      );
    const pendingCommand =
      snapshot === undefined
        ? undefined
        : [...this.commands.values()].find(
            (command) => command.snapshot === snapshot,
          );
    if (snapshot !== undefined && pendingCommand === undefined) {
      const cleanup = await this.discard(snapshot);
      if (signal?.aborted && result.ok)
        result = err(
          cancelledBy(request.operation, signal, {
            partialObservation: createPcapEvidence(request, result.value),
          }),
        );
      if (cleanup !== undefined) {
        if (result.ok) {
          const failure = cleanup.retainPartialObservation(
            createPcapEvidence(request, result.value),
          );
          result = err(failure);
          this.snapshotFailures.set(
            snapshot,
            new RetainedSnapshotFailure(failure, failure),
          );
        } else {
          const returned = analysisErrorWithCleanupFailure(
            result.error,
            cleanup,
            request.operation,
          ).bindCleanupDependencies([cleanup]);
          result = err(returned);
          this.snapshotFailures.set(
            snapshot,
            new RetainedSnapshotFailure(returned, cleanup),
          );
        }
      }
    }
    if (snapshot !== undefined && pendingCommand !== undefined) {
      const partialObservation = result.ok
        ? createPcapEvidence(request, result.value)
        : result.error.partialObservation;
      const capturedOutput = result.ok
        ? undefined
        : result.error.capturedOutput;
      let commandFailure = pendingCommand.failure;
      if (commandFailure === undefined) {
        commandFailure = new ProviderCleanupError(
          "pcap",
          pendingCommand.resources,
          {
            reason: pendingCommand.reason,
            captured_output: { ...pendingCommand.capturedOutput },
          },
          { operation: request.operation },
        );
        pendingCommand.retainFailure(commandFailure);
      }
      const snapshotFailure = new ProviderCleanupError(
        "pcap",
        [snapshot.path],
        {
          reason:
            "Capture snapshot remains owned until command cleanup completes.",
        },
        { operation: request.operation },
      );
      const cleanupFailure = new ProviderCleanupError(
        "pcap",
        [...new Set([snapshot.path, ...pendingCommand.resources])],
        {
          reason: pendingCommand.reason,
          previous_error: result.ok ? null : projectAnalysisError(result.error),
          ...(capturedOutput === undefined &&
          pendingCommand.capturedOutput.stdout === "" &&
          pendingCommand.capturedOutput.stderr === ""
            ? {}
            : {
                captured_output: {
                  ...(capturedOutput ?? pendingCommand.capturedOutput),
                },
              }),
        },
        {
          operation: request.operation,
          ...(partialObservation === undefined ? {} : { partialObservation }),
        },
      );
      const returned = result.ok
        ? cleanupFailure
            .retainPartialObservation(partialObservation!)
            .bindCleanupDependencies([commandFailure, snapshotFailure])
        : result.error instanceof PcapCommandCleanupError
          ? result.error.bindCleanupDependencies([
              commandFailure,
              snapshotFailure,
            ])
          : analysisErrorWithCleanupFailure(
              result.error,
              cleanupFailure,
              request.operation,
            ).bindCleanupDependencies([commandFailure, snapshotFailure]);
      result = err(returned);
      this.snapshotFailures.set(
        snapshot,
        new RetainedSnapshotFailure(returned, snapshotFailure),
      );
    }
    if (
      snapshot !== undefined &&
      this.snapshots.has(snapshot) &&
      !result.ok &&
      result.error.cleanupIncomplete &&
      !this.snapshotFailures.has(snapshot)
    )
      this.snapshotFailures.set(
        snapshot,
        new RetainedSnapshotFailure(result.error, result.error),
      );
    return result;
  }

  private async inspectCapture(
    selection: PcapToolSelection,
    snapshot: PcapSnapshot,
    path: string,
    identity: { bytes: number; sha256: string },
    signal: AbortSignal | undefined,
    request: PcapRequest,
    provider: {
      readonly id: string;
      readonly name: string;
      readonly version: string | null;
    },
    client: unknown,
  ) {
    const withOutputCleanup = (
      cause: unknown,
      command: PcapCommandOutput,
    ): unknown => {
      if (command.cleanup === undefined) return cause;
      return analysisErrorWithCleanupFailure(
        cause instanceof AnalysisError
          ? cause
          : new AnalysisProtocolError("Packet capture output parsing failed", {
              cause,
            }),
        pcapCommandCleanupError(
          request.operation,
          snapshot.path,
          command.cleanup,
          command.capturedOutput,
        ),
        request.operation,
      );
    };
    const info = await this.run(
      "inspect_pcap_capture",
      "capinfos",
      selection.capinfos.command,
      ["-M", "-S", "--", snapshot.path],
      { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 },
      signal,
      snapshot,
      path,
    );
    let metadata: ReturnType<typeof parseCapinfosOutput>;
    try {
      metadata = parseCapinfosOutput(info.stdout);
      if (metadata.sha256 !== null && metadata.sha256 !== identity.sha256)
        throw new AnalysisProtocolError(
          "capinfos SHA256 disagrees with the owned capture snapshot",
          {
            diagnostics: {
              reason: "capture_sha256_mismatch",
              capinfos_sha256: metadata.sha256,
              snapshot_sha256: identity.sha256,
            },
          },
        );
    } catch (cause) {
      throw withOutputCleanup(cause, info);
    }
    if (info.cleanup !== undefined)
      throw pcapCommandCleanupError(
        request.operation,
        snapshot.path,
        info.cleanup,
        info.capturedOutput,
        pcapPartialEvidence(
          request,
          provider,
          path,
          identity,
          {
            client,
            target: { path, ...identity },
            stage: "capinfos-complete-tshark-not-run",
            file_type: metadata.fileType,
            encapsulation: metadata.encapsulation,
            packet_count: metadata.packetCount,
            capture_start: metadata.captureStart,
            capture_end: metadata.captureEnd,
            capture_duration_seconds: metadata.captureDurationSeconds,
            snapshot_length: metadata.snapshotLength,
          },
          [
            "capinfos output was parsed from a complete bounded stream, but process-tree cleanup remains unconfirmed; tshark was not run",
          ],
        ),
      );
    const dissected = await this.run(
      "inspect_pcap_capture",
      "tshark",
      selection.tshark.command,
      [
        "-n",
        "-r",
        snapshot.path,
        "-T",
        "json",
        "--no-duplicate-keys",
        `--temp-dir=${snapshot.configurationPath}`,
        ...FIELDS.flatMap((field) => ["-e", field]),
      ],
      { timeoutMs: 300_000, maxOutputBytes: TSHARK_JSON_MAX_BYTES },
      signal,
      snapshot,
      path,
    );
    const parseOutput = async (
      command: typeof dissected,
      dnsStdout?: string,
    ) => {
      try {
        return await parseTsharkJsonOutput(dissected.stdout, signal, dnsStdout);
      } catch (cause) {
        throw withOutputCleanup(cause, command);
      }
    };
    let fields = await parseOutput(dissected);
    let dnsDissected: typeof dissected | undefined;
    let dnsLimitation: string | undefined;
    if (dissected.cleanup === undefined) {
      try {
        dnsDissected = await this.run(
          "inspect_pcap_capture",
          "tshark",
          selection.tshark.command,
          [
            "-n",
            "-r",
            snapshot.path,
            "-T",
            "json",
            "--no-duplicate-keys",
            `--temp-dir=${snapshot.configurationPath}`,
            "-Y",
            "dns || mdns || llmnr",
            "-x",
            "-J",
            "frame dns mdns llmnr",
          ],
          { timeoutMs: 300_000, maxOutputBytes: TSHARK_JSON_MAX_BYTES },
          signal,
          snapshot,
          path,
        );
        fields = await parseOutput(dnsDissected, dnsDissected.stdout);
      } catch (cause) {
        if (cause instanceof AnalysisError && cause.cleanupIncomplete)
          throw cause;
        if (
          !(
            cause instanceof AnalysisResourceConstraintError ||
            cause instanceof AnalysisProtocolError ||
            cause instanceof AnalysisOutputError ||
            cause instanceof UnclassifiedProviderFailure
          )
        )
          throw cause;
        dnsLimitation = `DNS wire identity extraction was unavailable: ${dnsFailureReason(cause)}; producer queries and addresses are retained without inferred ownership`;
      }
    } else {
      dnsLimitation =
        "DNS wire identity extraction was not run because first-pass process cleanup remains unconfirmed; DNS coverage remains unknown";
    }
    if (dnsLimitation !== undefined) fields = { ...fields, partial: true };
    await snapshot.verify(identity, path, signal);
    if (fields.packetCount !== metadata.packetCount)
      throw new AnalysisProtocolError(
        `capinfos counted ${String(metadata.packetCount)} packets but tshark returned ${String(fields.packetCount)}`,
        {
          diagnostics: {
            reason: "packet_count_mismatch",
            capinfos_packet_count: metadata.packetCount,
            tshark_packet_count: fields.packetCount,
          },
        },
      );
    const captured = {
      result: {
        target: { path, ...identity },
        file_type: metadata.fileType,
        encapsulation: metadata.encapsulation,
        packet_count: metadata.packetCount,
        capture_start: metadata.captureStart,
        capture_end: metadata.captureEnd,
        capture_duration_seconds: metadata.captureDurationSeconds,
        diagnostics: {
          capinfos_stderr: info.stderr,
          tshark_stderr: [dissected.stderr, dnsDissected?.stderr ?? ""]
            .filter(Boolean)
            .join("\n"),
        },
        snapshot_length: metadata.snapshotLength,
        endpoints: fields.endpoints,
        endpoint_count: fields.endpointCount,
        dns_queries: fields.dnsQueries,
        dns_query_count: fields.dnsQueryCount,
        tls_sni_values: fields.tlsSniValues,
        tls_sni_count: fields.tlsSniCount,
        protocol_distribution: fields.protocolDistribution,
        protocol_count: fields.protocolCount,
        http_request_uris: fields.httpRequestUris,
        http_request_uri_count: fields.httpRequestUriCount,
        http_uri_redaction_count: fields.httpUriRedactionCount,
        unattributed_dns_addresses: fields.unattributedDnsAddresses,
        unattributed_dns_address_count: fields.unattributedDnsAddressCount,
        unattributed_dns_packet_count: fields.unattributedDnsPackets,
        coverage: fields.partial ? "partial" : "complete",
      },
      limitations: [
        ...fields.dnsLimitations.map((reason) => `DNS wire parsing: ${reason}`),
        ...(dnsLimitation === undefined ? [] : [dnsLimitation]),
        ...this.nativeLimitations,
        "Both tools read one owned snapshot; target identity comes from its admitted source descriptor",
        "DNS address attribution requires one wire-identified question in one decoded DNS message; declared truncation marks coverage partial. Only matching answer owners or unambiguous answer-section CNAME chains are associated. Authority, additional, unrelated and ambiguous addresses are retained separately as unattributed; these packet-local relationships do not prove final resolution",
        "Only bytes present in the saved capture are examined; encryption and capture truncation can hide higher-level fields",
        "HTTP URI inventory examines decoded HTTP/1 and HTTP/2 request fields; HTTP/3 URI semantics are outside this profile",
        ...(fields.partial
          ? [
              "One or more projected categories were capped, credential-bearing URIs were omitted or coalesced, DNS messages declare truncation, or DNS address attribution or HTTP URI targets remain unresolved; counts retain the examined totals",
            ]
          : []),
        ...(fields.httpUriRedactionCount > 0
          ? [
              "HTTP transport credentials were excluded; ambiguous credential spans cause the URI to be omitted",
            ]
          : []),
        ...(fields.unattributedDnsPackets > 0
          ? [
              `DNS address attribution was unresolved in ${String(fields.unattributedDnsPackets)} packet(s); unattributed addresses are retained separately`,
            ]
          : []),
      ],
    };
    const cleanupCommand =
      dissected.cleanup !== undefined ? dissected : dnsDissected;
    if (cleanupCommand?.cleanup !== undefined) {
      const full = pcapResultSchemas.inspect_pcap_capture.parse({
        client,
        ...captured.result,
      });
      throw pcapCommandCleanupError(
        request.operation,
        snapshot.path,
        cleanupCommand.cleanup,
        cleanupCommand.capturedOutput,
        pcapPartialEvidence(
          request,
          provider,
          path,
          identity,
          full,
          captured.limitations,
        ),
      );
    }
    return captured;
  }
}
