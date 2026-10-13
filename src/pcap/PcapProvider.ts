import type {
  ExecutionOptions,
  ProviderAvailability,
} from "../application/AnalysisProvider.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import {
  pcapResultSchemas,
  type PcapRequest,
  type PcapOperation,
} from "../domain/pcap/pcapAnalysis.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  PcapConfigurationFailure,
  inspectPcapClient,
  resolvePcapTools,
  pcapConfigurationAvailability,
  pcapToolUnavailable,
  type PcapToolSelection,
} from "./PcapConfiguration.js";
import {
  parseCapinfosOutput,
  parseTsharkJsonOutput,
  TSHARK_JSON_MAX_BYTES,
} from "./PcapOutput.js";
import { runPcapCommand, type PcapCommandLimits } from "./PcapCommand.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { createPcapEvidence } from "../domain/pcap/pcapEvidence.js";
import { preparePcapNativeBound } from "./PcapNativeBound.js";
import { PcapSnapshot } from "./PcapSnapshot.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import { readLinuxResourceLimits } from "../process/LinuxResourceLimits.js";

export const PCAP_PROVIDER_IDENTITY = {
  id: "pcap",
  name: "Packet capture analysis",
  version: null,
} as const;
const FIELDS = [
  "frame.number",
  "frame.protocols",
  "ip.src",
  "ip.dst",
  "ipv6.src",
  "ipv6.dst",
  "dns.flags.response",
  "dns.qry.name",
  "dns.a",
  "dns.aaaa",
  "tls.handshake.extensions_server_name",
  "http.request.full_uri",
];

export interface PcapProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Inspect saved captures through bounded, owned tool processes and one stable input copy. */
export class PcapProvider {
  readonly #resources = new ArtifactAnalysisResources(
    "pcap",
    "inspect_pcap_capture",
    readStableArtifact,
    readLinuxResourceLimits,
    {
      message: "A packet summary is already active; retry after it completes.",
      details: { max_concurrent_inspections: 1 },
    },
  );
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly snapshots = new Set<PcapSnapshot>();
  private readonly commands = new Map<
    ProviderProcessSupervisor,
    { snapshot: PcapSnapshot | undefined; resources: readonly string[] }
  >();

  constructor(options: PcapProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
  }

  private run(
    operation: PcapOperation,
    command: string,
    args: readonly string[],
    limits: PcapCommandLimits,
    signal: AbortSignal | undefined,
    snapshot?: PcapSnapshot,
    inputPath?: string,
  ) {
    return runPcapCommand({
      operation,
      command,
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
      retain: (owner, resources) => {
        this.commands.set(owner, { snapshot, resources });
      },
    });
  }

  private nativeBound: Parameters<typeof runPcapCommand>[0]["nativeBound"];
  private nativeLimitations: readonly string[] = [];

  private async prepareCaptureBound(): Promise<void> {
    const prepared = await preparePcapNativeBound(
      this.environment,
      this.#resources,
    );
    this.nativeBound = prepared.nativeBound;
    this.nativeLimitations = prepared.limitations;
  }

  private async client(operation: PcapOperation, signal?: AbortSignal) {
    const selection = resolvePcapTools(this.environment);
    const identity = await inspectPcapClient(
      selection,
      async (command) =>
        (
          await this.run(
            operation,
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
        capinfos_command: selection.capinfos.command,
        capinfos_source: selection.capinfos.source,
        capinfos_version: identity.capinfosVersion,
      },
    };
  }

  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    const result = await this.#resources.run(
      async () => ok(await this.inspectAvailabilityAdmitted(signal)),
      signal,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }

  private async inspectAvailabilityAdmitted(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    try {
      const { client } = await this.client("inspect_pcap_client", signal);
      if (process.platform !== "linux" && process.platform !== "win32")
        return {
          status: "unavailable",
          code: "unsupported_host",
          reason:
            "No enforceable native memory boundary is available for capture summaries on this host.",
          diagnostics: client,
        };
      await this.prepareCaptureBound();
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: client,
      };
    } catch (cause) {
      if (signal?.aborted || cause instanceof AnalysisCancelledError)
        throw new AnalysisCancelledError("inspect_pcap_client", { cause });
      if (cause instanceof PcapConfigurationFailure)
        return pcapConfigurationAvailability(cause);
      return {
        status: "unavailable",
        code:
          cause instanceof AnalysisCapabilityUnavailableError
            ? "executable_missing"
            : "version_unresolved",
        reason: cause instanceof Error ? cause.message : String(cause),
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
          (command) => command.snapshot === snapshot,
        )
      )
        throw new Error(
          "An unreleased command still owns the capture snapshot",
        );
      await snapshot.close();
      this.snapshots.delete(snapshot);
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

  async close(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#resources.close();
    } catch (cause) {
      failures.push(cause);
    }
    for (const owner of this.commands.keys()) {
      try {
        const result = await owner.stop();
        if (result.status === "incomplete") failures.push(result.reason);
        else if (result.status === "not-owned")
          failures.push("Command ownership remains unresolved");
        else this.commands.delete(owner);
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const snapshot of this.snapshots) {
      const failure = await this.discard(snapshot);
      if (failure !== undefined) failures.push(failure);
    }
    if (failures.length > 0)
      throw new ProviderCleanupError(
        "pcap",
        [...this.snapshots]
          .map((snapshot) => snapshot.path)
          .concat(
            [...this.commands.values()].flatMap((command) => command.resources),
          ),
        { reason: "Owned process or snapshot cleanup failed" },
        { operation: "pcap.close", cause: new AggregateError(failures) },
      );
  }

  async execute(
    request: PcapRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    return this.#resources.run(
      () => this.executeAdmitted(request, options),
      options?.signal,
    );
  }

  private async executeAdmitted(
    request: PcapRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const signal = options?.signal;
    let snapshot: PcapSnapshot | undefined;
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      signal?.throwIfAborted();
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
        await this.prepareCaptureBound();
        snapshot = await PcapSnapshot.create();
        this.snapshots.add(snapshot);
        const identity = await snapshot.capture(request.input.path, signal);
        const captured = await this.inspectCapture(
          selection,
          snapshot,
          request.input.path,
          identity,
          signal,
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
        cause instanceof AnalysisError
          ? cause
          : signal?.aborted
            ? new AnalysisCancelledError(request.operation, { cause })
            : cause instanceof PcapConfigurationFailure
              ? pcapToolUnavailable(request.operation, cause.message, {
                  cause,
                })
              : new AnalysisProtocolError(
                  `Packet-capture analysis failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                  { cause },
                ),
      );
    }
    if (signal?.aborted && result.ok)
      result = err(
        new AnalysisCancelledError(request.operation, {
          cause: signal.reason,
          partialObservation: createPcapEvidence(request, result.value),
        }),
      );
    if (snapshot !== undefined) {
      const cleanup = await this.discard(snapshot);
      if (signal?.aborted && result.ok)
        result = err(
          new AnalysisCancelledError(request.operation, {
            cause: signal.reason,
            partialObservation: createPcapEvidence(request, result.value),
          }),
        );
      if (cleanup !== undefined)
        result = result.ok
          ? err(
              cleanup.retainPartialObservation(
                createPcapEvidence(request, result.value),
              ),
            )
          : err(
              analysisErrorWithCleanupFailure(
                result.error,
                cleanup,
                request.operation,
              ),
            );
    }
    return result;
  }

  private async inspectCapture(
    selection: PcapToolSelection,
    snapshot: PcapSnapshot,
    path: string,
    identity: { bytes: number; sha256: string },
    signal: AbortSignal | undefined,
  ) {
    const info = await this.run(
      "inspect_pcap_capture",
      selection.capinfos.command,
      ["-M", "--", snapshot.path],
      { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 },
      signal,
      snapshot,
      path,
    );
    const metadata = parseCapinfosOutput(info.stdout);
    if (metadata.sha256 !== null && metadata.sha256 !== identity.sha256)
      throw new AnalysisProtocolError(
        "capinfos SHA256 disagrees with the owned capture snapshot",
      );
    const dissected = await this.run(
      "inspect_pcap_capture",
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
    const fields = await parseTsharkJsonOutput(dissected.stdout, signal);
    await snapshot.verify(identity, path, signal);
    if (fields.packetCount !== metadata.packetCount)
      throw new AnalysisProtocolError(
        `capinfos counted ${String(metadata.packetCount)} packets but tshark returned ${String(fields.packetCount)}`,
      );
    return {
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
          tshark_stderr: dissected.stderr,
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
        ...this.nativeLimitations,
        "Both tools read one owned snapshot; target identity comes from its admitted source descriptor",
        "DNS address values are associated only with a single question in the same response packet; values may include additional DNS records, not only final resolution answers",
        "Only bytes present in the saved capture are examined; encryption and capture truncation can hide higher-level fields",
        ...(fields.partial
          ? [
              "One or more projected categories were capped, credential-bearing URIs were omitted or coalesced, or DNS address attribution remains unresolved; counts retain the examined totals",
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
  }
}
