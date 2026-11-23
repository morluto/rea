import { binaryMetadataArchitecture } from "../../domain/binaryMetadataArchitecture.js";
import {
  machoSelectionAnswersArchitecture,
  metadataReportSubjectFormat,
} from "../../domain/apple/machoTargetSelection.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { RustBinaryPort } from "../../ports/rust/RustBinaryPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  rustBinarySchema,
  type InspectRustBinaryInput,
} from "../../domain/rust/rustBinary.js";
import { inspectRustBinaryRequestSchema } from "../../domain/rust/rustBinaryQuery.js";
import type { Result } from "../../domain/result.js";
import type { AnalysisViewRetention } from "../analysisView/AnalysisViewService.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_rust_binary";

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class RustBinaryService {
  constructor(readonly provider: RustBinaryPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  /** Inspect one explicitly selected file without acquiring a binary session. */
  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
    retention?: AnalysisViewRetention,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectRustBinaryRequestSchema,
        outputSchema: rustBinarySchema,
        provider: this.provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "Rust dependency reader returned malformed metadata or changed the selected artifact or slice identity.",
        toParameters: ({ detail: _detail, view: _view, ...parameters }) =>
          parameters,
        selectRetainedView: ({ detail, view }) =>
          detail === "summary" || view !== undefined
            ? view === undefined
              ? { kind: "summary" }
              : { kind: "rust", ...view }
            : undefined,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          machoSelectionAnswersArchitecture(
            report.selected_slice,
            parameters.architecture,
          ),
        buildEvidence: (report, identity, parameters) =>
          evidenceFor(identity, parameters, report),
      },
      rawInput,
      options,
      retention,
    );
  }
}

const evidenceFor = (
  provider: RustBinaryPort["identity"],
  parameters: InspectRustBinaryInput,
  value: ReturnType<typeof rustBinarySchema.parse>,
): Evidence => {
  const architecture = binaryMetadataArchitecture(value.architecture);
  const section = value.auditable_metadata;
  return createEvidence(
    {
      path: value.artifact.path,
      sha256: value.artifact.sha256,
      format: metadataReportSubjectFormat(value),
      ...(architecture === undefined ? {} : { architecture }),
    },
    provider,
    {
      operation: OPERATION,
      parameters,
      result: value,
      confidence: "observed",
      limitations: value.limitations,
      locations: [
        { kind: "artifact-path", path: value.artifact.path },
        ...(section === null
          ? []
          : [
              {
                kind: "file-offset-range" as const,
                start: section.file_offset,
                end: section.file_offset + section.section_bytes,
              },
            ]),
      ],
    },
  );
};
