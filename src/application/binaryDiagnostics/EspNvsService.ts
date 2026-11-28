import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../../ports/AnalysisProvider.js";
import type { EspNvsPort } from "../../ports/binaryDiagnostics/EspNvsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  espNvsReportSchema,
  inspectEspNvsRequestSchema,
  type EspNvsProviderInput,
  type EspNvsReport,
} from "../../domain/firmware/espNvs.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import type { AnalysisViewRetention } from "../analysisView/AnalysisViewRetention.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const OPERATION = "inspect_esp_nvs";

const validNvsReport = (
  report: EspNvsReport,
  input: EspNvsProviderInput,
): boolean => {
  if (report.artifact.path !== input.path) return false;
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.partition_range.start !== input.partition_offset) return false;
  if (report.partition_range.end > report.artifact.bytes) return false;
  if (
    input.partition_bytes !== undefined &&
    report.partition_range.end - report.partition_range.start !==
      input.partition_bytes
  ) {
    return false;
  }
  return (
    report.coverage.retained_entries === report.entries.length &&
    report.coverage.omitted_entries === 0
  );
};

const createNvsEvidence = (
  value: EspNvsReport,
  identity: ProviderIdentity,
  parameters: unknown,
  evidenceLinks?: readonly string[],
): Evidence =>
  createEvidence(
    {
      path: value.artifact.path,
      format: "file",
      sha256: value.artifact.sha256,
    },
    identity,
    {
      operation: OPERATION,
      parameters,
      result: value,
      confidence: "observed",
      limitations: value.limitations,
      ...(evidenceLinks === undefined ? {} : { evidenceLinks }),
      locations: [
        { kind: "artifact-path", path: value.artifact.path },
        {
          kind: "file-offset-range",
          start: value.partition_range.start,
          end: value.partition_range.end,
        },
      ],
    },
  );

/** Shared caller validation, output parsing, and Evidence provenance for CLI/MCP. */
export class EspNvsService {
  constructor(readonly provider: EspNvsPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
    retention?: AnalysisViewRetention,
  ): Promise<Result<Evidence, AnalysisError>> {
    const selectedParameters = callerAnalysisParameters(rawInput);
    let requestedMaxEntries: number | undefined;
    let resolvedProviderInput: EspNvsProviderInput | undefined;
    let completeReport: EspNvsReport | undefined;

    const inspected = await executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectEspNvsRequestSchema,
        outputSchema: espNvsReportSchema,
        provider: this.provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "ESP-IDF NVS provider returned malformed output or mismatched artifact identity.",
        toParameters: ({
          detail: _detail,
          max_entries: maxEntries,
          ...providerInput
        }) => {
          requestedMaxEntries = maxEntries;
          resolvedProviderInput = providerInput;
          return providerInput;
        },
        selectRetainedView: ({ detail }) =>
          detail === "summary" ? { kind: "summary" } : undefined,
        validateReport: validNvsReport,
        buildEvidence: (value, identity, parameters) => {
          completeReport = value;
          return createNvsEvidence(
            value,
            identity,
            selectedParameters(parameters),
          );
        },
      },
      rawInput,
      options,
      retention,
    );

    if (
      !inspected.ok ||
      requestedMaxEntries === undefined ||
      completeReport === undefined ||
      resolvedProviderInput === undefined ||
      inspected.value.operation !== OPERATION
    ) {
      return inspected;
    }

    if (completeReport.entries.length <= requestedMaxEntries) {
      return completeProviderEvidence(
        createNvsEvidence(
          completeReport,
          this.provider.identity,
          selectedParameters({
            ...resolvedProviderInput,
            max_entries: requestedMaxEntries,
          }),
        ),
        options?.signal,
      );
    }

    const completeEvidence = inspected.value;
    let retainedParentId: string | undefined;
    if (retention?.recordEvidence !== undefined) {
      const recorded = retention.recordEvidence(completeEvidence);
      if (!recorded.ok) return recorded;
      retainedParentId = completeEvidence.evidence_id;
    }

    const omitted = completeReport.entries.length - requestedMaxEntries;
    const boundedReport: EspNvsReport = {
      ...completeReport,
      coverage: {
        ...completeReport.coverage,
        status: "partial",
        retained_entries: requestedMaxEntries,
        omitted_entries: omitted,
      },
      entries: completeReport.entries.slice(0, requestedMaxEntries),
      limitations: [
        ...completeReport.limitations,
        retainedParentId === undefined
          ? `Omitted ${String(omitted)} decoded NVS entries past inline max_entries (${String(requestedMaxEntries)}).`
          : `Omitted ${String(omitted)} decoded NVS entries past inline max_entries (${String(requestedMaxEntries)}); complete decoded entries remain retained in Evidence ${retainedParentId} (query inspect_analysis_view with kind esp-nvs or evidence-json).`,
      ],
    };

    return completeProviderEvidence(
      createNvsEvidence(
        boundedReport,
        this.provider.identity,
        selectedParameters({
          ...resolvedProviderInput,
          max_entries: requestedMaxEntries,
        }),
        retainedParentId === undefined ? undefined : [retainedParentId],
      ),
      options?.signal,
    );
  }
}
