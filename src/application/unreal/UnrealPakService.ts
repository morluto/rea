import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisViewRetention } from "../analysisView/AnalysisViewService.js";
import type { UnrealPakPort } from "../../ports/unreal/UnrealPakPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { Result } from "../../domain/result.js";
import {
  inspectUnrealPakInputSchema,
  unrealPakSchema,
  type UnrealPak,
} from "../../domain/unreal/unrealPak.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_unreal_pak";

/** File ranges the report says it decoded: the footer and every index region it read. */
const decodedRegions = (report: UnrealPak) => [
  { offset: report.footer.offset, size: report.footer.size },
  ...(report.index.state === "decoded"
    ? [
        report.footer.index,
        ...(report.index.path_hash_index === null
          ? []
          : [report.index.path_hash_index.region]),
        ...(report.index.full_directory_index === null
          ? []
          : [report.index.full_directory_index.region]),
      ]
    : []),
];

/** Shared exact input validation, artifact-bound Evidence and summary delivery for CLI and MCP. */
export class UnrealPakService {
  constructor(readonly provider: UnrealPakPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /**
   * Inspect one explicitly selected file; detail changes delivery, not decoded
   * coverage. Provider failures return unchanged with their source Evidence.
   */
  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
    retention?: AnalysisViewRetention,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectUnrealPakInputSchema,
        outputSchema: unrealPakSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Unreal pak reader returned a malformed report or changed the selected artifact identity.",
        toParameters: ({ detail: _detail, ...providerInput }) => providerInput,
        selectRetainedView: ({ detail }) =>
          detail === "summary" ? { kind: "summary" } : undefined,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path,
        buildEvidence: (value, identity, parameters) =>
          createEvidence(
            {
              path: value.artifact.path,
              sha256: value.artifact.sha256,
              format: "file",
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
                ...decodedRegions(value)
                  .filter(({ size }) => size > 0)
                  .map(({ offset, size }) => ({
                    kind: "file-offset-range" as const,
                    start: offset,
                    end: offset + size,
                  })),
              ],
            },
          ),
      },
      rawInput,
      options,
      retention,
    );
  }
}
