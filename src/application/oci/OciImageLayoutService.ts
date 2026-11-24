import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { OciImageLayoutPort } from "../../ports/oci/OciImageLayoutPort.js";
import type {
  AnalysisError,
  AnalysisPartialObservation,
} from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { recognizeEvidence } from "../../domain/evidenceValidation.js";
import {
  inspectOciImageLayoutInputSchema,
  ociImageLayoutSchema,
  type InspectOciImageLayoutInput,
  type OciImageLayout,
} from "../../domain/oci/imageLayout.js";
import {
  createOciImageLayoutEvidence,
  INSPECT_OCI_IMAGE_LAYOUT_OPERATION,
} from "../../domain/oci/imageLayoutEvidence.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import {
  executeArtifactInspection,
  type ArtifactInspectionPort,
} from "../ArtifactInspectionExecution.js";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class OciImageLayoutService {
  constructor(readonly provider: OciImageLayoutPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const provider: ArtifactInspectionPort<
      InspectOciImageLayoutInput,
      OciImageLayout
    > = {
      identity: this.provider.identity,
      inspect: async (input, executionOptions) => {
        const result = await this.provider.inspect(input, executionOptions);
        if (!result.ok) unwrapProviderReport(result.error, input);
        return result;
      },
    };
    return executeArtifactInspection(
      {
        operation: INSPECT_OCI_IMAGE_LAYOUT_OPERATION,
        inputSchema: inspectOciImageLayoutInputSchema,
        outputSchema: ociImageLayoutSchema,
        provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "OCI image layout provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, input) =>
          report.artifact.path === input.path && validReport(report, input),
        buildEvidence: (report, identity, parameters) =>
          createOciImageLayoutEvidence(
            identity,
            callerAnalysisParameters(rawInput)(parameters),
            report,
          ),
      },
      rawInput,
      options,
    );
  }
}

/**
 * The provider stores a completed inventory on a cleanup failure as Evidence
 * naming resolved defaults. Unwrap a valid report on the error and every
 * cleanupPrimary holding the same partialObservation so the shared
 * retainCompletedReport path rebuilds Evidence from the caller's selections.
 */
const unwrapProviderReport = (
  error: AnalysisError,
  input: InspectOciImageLayoutInput,
): void => {
  const source = error.partialObservation;
  const recognized = recognizeEvidence(source);
  if (
    !recognized.ok ||
    recognized.value?.operation !== INSPECT_OCI_IMAGE_LAYOUT_OPERATION
  )
    return;
  const report = ociImageLayoutSchema.safeParse(
    recognized.value.normalized_result,
  );
  if (
    !report.success ||
    report.data.artifact.path !== input.path ||
    !validReport(report.data, input)
  )
    return;
  const raw = recognized.value
    .normalized_result as unknown as AnalysisPartialObservation;
  const seen = new Set<AnalysisError>();
  for (
    let owner: AnalysisError | undefined = error;
    owner !== undefined && !seen.has(owner);
    owner = owner.cleanupPrimary
  ) {
    seen.add(owner);
    if (owner.partialObservation === source) owner.partialObservation = raw;
  }
};

const validReport = (
  report: OciImageLayout,
  input: {
    readonly max_json_bytes: number;
    readonly max_blob_bytes: number;
    readonly max_entries: number;
    readonly max_descriptors: number;
    readonly max_index_depth: number;
  },
): boolean => {
  // The report does not count document reads, and failed or truncated
  // manifests and nested indexes are read without appearing in it. Every
  // nested index or manifest read is charged one descriptor, and each
  // manifest reads at most one config, so oci-layout, index.json and two
  // documents per descriptor bound how many JSON documents were read.
  if (
    report.coverage.entries_examined > input.max_entries ||
    report.coverage.json_bytes_read >
      input.max_json_bytes * (2 + 2 * input.max_descriptors)
  )
    return false;
  if (report.indexes.some((index) => index.depth > input.max_index_depth))
    return false;
  return report.artifact.format === "directory";
};
