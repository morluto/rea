import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { KernelBuildConfigPort } from "../../ports/binaryDiagnostics/KernelBuildConfigPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectKernelBuildConfigInputSchema,
  kernelBuildConfigSchema,
  KERNEL_BUILD_CONFIG_MALFORMED_REASONS,
  KERNEL_BUILD_CONFIG_MARKER_BYTES,
  KERNEL_BUILD_CONFIG_NUMBER,
  type InspectKernelBuildConfigInput,
  type KernelBuildConfig,
  type KernelBuildConfigEntry,
} from "../../domain/native/kernelBuildConfig.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_kernel_build_config";
const MARKER_BYTES = KERNEL_BUILD_CONFIG_MARKER_BYTES;

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class KernelBuildConfigService {
  constructor(readonly provider: KernelBuildConfigPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectKernelBuildConfigInputSchema,
        outputSchema: kernelBuildConfigSchema,
        provider: this.provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "Kernel build config provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
        buildEvidence: (value, identity, parameters) =>
          createEvidence(
            {
              path: value.artifact.path,
              format: value.format === "elf" ? "elf" : "file",
              sha256: value.artifact.sha256,
            },
            identity,
            {
              operation: OPERATION,
              parameters,
              result: value,
              confidence: "observed",
              limitations: value.limitations,
              locations: locationsOf(value),
            },
          ),
      },
      rawInput,
      options,
    );
  }
}

const fits = (
  length: number,
  range: { offset: number; bytes: number },
): boolean => range.bytes <= length && range.offset <= length - range.bytes;

const metadataRanges = ({ banner, config }: KernelBuildConfig) =>
  [banner.location, config.marker, config.gzip, config.end_marker].filter(
    (range) => range !== null,
  );

const fileRanges = (report: KernelBuildConfig) => [
  ...(report.payload.offset !== null && report.payload.bytes !== null
    ? [{ offset: report.payload.offset, bytes: report.payload.bytes }]
    : []),
  ...metadataRanges(report).filter((range) => range.space === "file"),
];

const locationsOf = (report: KernelBuildConfig) => [
  { kind: "artifact-path" as const, path: report.artifact.path },
  ...fileRanges(report).map((range) => ({
    kind: "file-offset-range" as const,
    start: range.offset,
    end: range.offset + range.bytes,
  })),
];

const valueAgrees = (entry: KernelBuildConfigEntry): boolean => {
  if (entry.trust !== "target-derived-untrusted") return false;
  if (entry.kind === "y" || entry.kind === "m")
    return entry.value === entry.kind;
  if (entry.kind === "not_set") return entry.value === null;
  if (entry.kind === "number")
    return entry.value !== null && KERNEL_BUILD_CONFIG_NUMBER.test(entry.value);
  return entry.value !== null;
};

const markersAgree = (config: KernelBuildConfig["config"]): boolean => {
  const { marker, gzip, end_marker } = config;
  if (marker === null || gzip === null || end_marker === null) return false;
  return (
    marker.bytes === MARKER_BYTES &&
    end_marker.bytes === MARKER_BYTES &&
    marker.space === gzip.space &&
    gzip.space === end_marker.space &&
    gzip.offset === marker.offset + MARKER_BYTES &&
    end_marker.offset === gzip.offset + gzip.bytes
  );
};

const rangesAgree = (report: KernelBuildConfig): boolean => {
  const { bytes, offset, inflated_bytes: inflated } = report.payload;
  if (
    offset !== null &&
    bytes !== null &&
    !fits(report.artifact.bytes, { offset, bytes })
  )
    return false;
  const space = inflated === null ? "file" : "inflated_payload";
  const extent = inflated ?? report.artifact.bytes;
  return metadataRanges(report).every(
    (range) => range.space === space && fits(extent, range),
  );
};

const bannerAgrees = (banner: KernelBuildConfig["banner"]): boolean => {
  if (banner.trust !== "target-derived-untrusted") return false;
  if (banner.status === "present") {
    if (
      banner.text === null ||
      banner.version === null ||
      banner.location === null ||
      banner.location.bytes !== banner.text.length ||
      !banner.text.startsWith(`Linux version ${banner.version}`)
    )
      return false;
    return /^[0-9][0-9A-Za-z.+_~+-]*$/u.test(banner.version);
  }
  return (
    banner.text === null &&
    banner.version === null &&
    banner.builder === null &&
    banner.compiler === null &&
    banner.location === null
  );
};

const configCountsAgree = (config: KernelBuildConfig["config"]): boolean => {
  const page = Math.min(
    config.limit,
    Math.max(0, config.matched_count - config.offset),
  );
  if (config.entries.length !== page) return false;
  if (config.matched_count > config.option_count) return false;
  if (config.name === null && config.matched_count !== config.option_count)
    return false;
  if (
    config.name !== null &&
    config.entries.some((entry) => entry.name !== config.name)
  )
    return false;
  if (config.status === "present")
    return (
      config.reason === null &&
      config.sha256 !== null &&
      config.option_count >= 1 &&
      markersAgree(config)
    );
  const empty =
    config.option_count === 0 &&
    config.matched_count === 0 &&
    config.entries.length === 0 &&
    config.sha256 === null;
  const malformedReason =
    config.reason !== null &&
    (KERNEL_BUILD_CONFIG_MALFORMED_REASONS as readonly string[]).includes(
      config.reason,
    );
  if (config.status === "malformed")
    return empty && malformedReason && markersAgree(config);
  return (
    empty &&
    !malformedReason &&
    config.marker === null &&
    config.gzip === null &&
    config.end_marker === null &&
    (config.status === "absent"
      ? config.reason === null
      : config.reason !== null)
  );
};

const payloadAgrees = (report: KernelBuildConfig): boolean => {
  const { payload } = report;
  if ((payload.status === "unsupported") !== (report.next_probe !== null))
    return false;
  if (payload.inflated_bytes !== null && payload.status !== "inflated")
    return false;
  if (payload.container === "file") {
    if (payload.status === "uncompressed")
      return (
        payload.codec === null &&
        payload.offset === null &&
        payload.bytes === null
      );
    return (
      payload.status === "unsupported" &&
      report.format === "file" &&
      payload.codec !== null &&
      payload.offset === 0 &&
      payload.bytes === report.artifact.bytes
    );
  }
  if (report.format !== "file") return false;
  if (payload.status === "unavailable" || payload.status === "truncated")
    if (payload.offset === null)
      return payload.codec === null && payload.bytes === null;
  if (payload.offset === null || payload.bytes === null) return false;
  if (payload.status === "inflated")
    return payload.codec === "gzip" && payload.inflated_bytes !== null;
  if (payload.status === "truncated" || payload.status === "malformed")
    return payload.codec === "gzip";
  return payload.status === "unsupported" && payload.codec !== "gzip";
};

const searchedAgrees = (report: KernelBuildConfig): boolean => {
  const searched =
    report.payload.status === "uncompressed" ||
    report.payload.status === "inflated";
  if (searched) {
    const examined =
      report.payload.status === "inflated"
        ? report.payload.inflated_bytes
        : report.artifact.bytes;
    if (report.coverage.examined_bytes !== examined) return false;
    if (report.banner.status === "unknown") return false;
    if (report.config.status === "present" || report.config.status === "absent")
      return report.coverage.status === "complete";
    // A cut or budget-stopped config is a known gap; a malformed one is unreadable.
    if (report.coverage.examined_entries !== 0) return false;
    if (report.config.status === "incomplete")
      return report.coverage.status === "partial";
    return (
      report.config.status === "malformed" &&
      report.coverage.status === "unknown"
    );
  }
  if (
    report.coverage.examined_bytes !== 0 ||
    report.coverage.examined_entries !== 0
  )
    return false;
  if (report.banner.status !== "unknown") return false;
  if (report.payload.status === "unsupported")
    return (
      report.coverage.status === "unsupported" &&
      report.config.status === "unsupported"
    );
  return (
    report.coverage.status === "unknown" &&
    report.config.status === "incomplete"
  );
};

const validReport = (
  report: KernelBuildConfig,
  input: InspectKernelBuildConfigInput,
): boolean => {
  if (
    report.artifact.bytes > input.max_file_bytes ||
    report.coverage.examined_entries > input.max_entries ||
    (report.payload.inflated_bytes ?? 0) > input.max_payload_bytes
  )
    return false;
  if (
    report.config.offset !== input.offset ||
    report.config.limit !== input.limit ||
    report.config.name !== (input.name ?? null)
  )
    return false;
  if (
    report.limitations.length === 0 ||
    !report.limitations.some((line) => line.includes("untrusted"))
  )
    return false;
  if (report.config.status === "present") {
    if (
      report.coverage.examined_entries !== report.config.option_count ||
      !markersAgree(report.config)
    )
      return false;
  } else if (report.coverage.examined_entries !== 0) return false;
  return (
    rangesAgree(report) &&
    bannerAgrees(report.banner) &&
    configCountsAgree(report.config) &&
    report.config.entries.every(valueAgrees) &&
    payloadAgrees(report) &&
    searchedAgrees(report)
  );
};
