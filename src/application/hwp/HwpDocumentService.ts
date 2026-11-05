import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { HwpDocumentPort } from "./HwpDocumentPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceSubjectTarget,
} from "../../domain/evidence.js";
import {
  inspectHwpDocumentInputSchema,
  hwpDocumentSchema,
  type InspectHwpDocumentInput,
  type HwpDocument,
  hwpInspectionParameters,
} from "../../domain/hwp/hwpDocument.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";

const OPERATION = "inspect_hwp_document";

const matchesSelectedDocument = (
  report: HwpDocument,
  input: InspectHwpDocumentInput,
  subject: EvidenceSubjectTarget,
): boolean =>
  report.artifact.path === input.path &&
  subject.path === input.path &&
  subject.sha256 === report.artifact.sha256 &&
  subject.format === "file";

/** Shared document inspection and input validation for CLI and MCP. */
export class HwpDocumentService {
  constructor(readonly provider: HwpDocumentPort) {}

  /** Await provider shutdown. */
  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /** Inspect an HWP/HWPX document and preserve its file identity. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const input = inspectHwpDocumentInputSchema.safeParse(rawInput);
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
    const inspected = await this.provider.inspect(input.data, options);
    if (!inspected.ok) return inspected;
    const execution = inspected.value;
    const report = hwpDocumentSchema.safeParse(execution.result);
    if (
      !report.success ||
      execution.subject === null ||
      !matchesSelectedDocument(report.data, input.data, execution.subject)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "HWP adapter returned malformed data or changed the selected document identity.",
        ),
      );
    return ok(
      createEvidence(execution.subject, execution.provider, {
        operation: OPERATION,
        parameters: hwpInspectionParameters(input.data),
        result: jsonValueSchema.parse(report.data),
        ...(execution.rawResult === null
          ? {}
          : { rawResult: execution.rawResult }),
        confidence: "observed",
        locations: execution.locations,
        limitations: execution.limitations,
      }),
    );
  }
}
