import { binaryMetadataArchitecture } from "../../domain/binaryMetadataArchitecture.js";
import {
  machoSelectionAnswersArchitecture,
  metadataReportSubjectFormat,
} from "../../domain/apple/machoTargetSelection.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { GoBinaryPort } from "../../ports/go/GoBinaryPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  goBinarySchema,
  inspectGoBinaryInputSchema,
} from "../../domain/go/goBinary.js";
import type { Result } from "../../domain/result.js";
import type { AnalysisViewRetention } from "../analysisView/AnalysisViewRetention.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_go_binary";

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class GoBinaryService {
  constructor(readonly provider: GoBinaryPort) {}

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
        inputSchema: inspectGoBinaryInputSchema,
        outputSchema: goBinarySchema,
        provider: this.provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "Go build-information reader returned malformed metadata or changed the selected artifact or slice identity.",
        toParameters: ({ detail: _detail, ...providerInput }) => providerInput,
        selectRetainedView: ({ detail }) =>
          detail === "summary" ? { kind: "summary" } : undefined,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          machoSelectionAnswersArchitecture(
            report.selected_slice,
            parameters.architecture,
          ),
        buildEvidence: (value, identity, parameters) => {
          const architecture = binaryMetadataArchitecture(value.architecture);
          return createEvidence(
            {
              path: value.artifact.path,
              sha256: value.artifact.sha256,
              format: metadataReportSubjectFormat(value),
              ...(architecture === undefined ? {} : { architecture }),
            },
            identity,
            {
              operation: OPERATION,
              parameters,
              result: value,
              confidence: "observed",
              limitations: value.limitations,
              locations: [
                { kind: "artifact-path", path: value.artifact.path },
                ...(value.build_info === null
                  ? []
                  : [
                      {
                        kind: "file-offset-range" as const,
                        start: value.build_info.header_offset,
                        end: value.build_info.header_offset + 32,
                      },
                    ]),
              ],
            },
          );
        },
      },
      rawInput,
      options,
      retention,
    );
  }
}
