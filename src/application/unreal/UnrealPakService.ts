import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
  type AnalysisViewRetention,
} from "../analysisView/AnalysisViewService.js";
import type { UnrealPakPort } from "./UnrealPakPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  inspectUnrealPakInputSchema,
  unrealPakSchema,
  type UnrealPak,
} from "../../domain/unreal/unrealPak.js";

const OPERATION = "inspect_unreal_pak";
const NO_RETENTION: AnalysisViewRetention = {
  evidenceById: undefined,
  recordEvidence: undefined,
};

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

  /** Inspect one explicitly selected file; detail changes delivery, not decoded coverage. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
    retention: AnalysisViewRetention = NO_RETENTION,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const input = inspectUnrealPakInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const { detail, ...providerInput } = input.data;
    if (detail === "summary") {
      const ready = requireAnalysisViewRetention(OPERATION, retention);
      if (!ready.ok) return ready;
    }
    const inspected = await this.provider.inspect(providerInput, options);
    if (!inspected.ok) return inspected;
    const report = unrealPakSchema.safeParse(inspected.value);
    if (!report.success || report.data.artifact.path !== providerInput.path)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Unreal pak reader returned a malformed report or changed the selected artifact identity.",
        ),
      );
    const value = report.data;
    const evidence = createEvidence(
      {
        path: value.artifact.path,
        sha256: value.artifact.sha256,
        format: "file",
      },
      this.provider.identity,
      {
        operation: OPERATION,
        parameters: providerInput,
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
    );
    // Cancellation after a complete read keeps the decoded facts.
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, {
          cause: options.signal.reason,
          partialObservation: evidence,
        }),
      );
    return detail === "summary"
      ? summarizeRetainedAnalysis(evidence, retention)
      : ok(evidence);
  }
}
