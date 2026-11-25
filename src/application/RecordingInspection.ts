import type { z } from "zod";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";
import type { Evidence, EvidenceSubjectTarget } from "../domain/evidence.js";
import { err, type Result } from "../domain/result.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../ports/AnalysisProvider.js";
import { parseAnalysisInput } from "./AnalysisInput.js";
import { completeProviderEvidence } from "./ProviderOperationExecution.js";

type FileIdentity = Pick<EvidenceSubjectTarget, "path" | "sha256">;

/** Select the reported artifact only when it names the caller's recording. */
export const selectedRecording = (
  report: { readonly artifact: FileIdentity },
  input: { readonly path: string },
): FileIdentity | undefined =>
  report.artifact.path === input.path ? report.artifact : undefined;

/** Validate the decoder's selection and subject before committing its original execution as Evidence. */
export const executeRecordingInspection = async <
  Input,
  Report extends { readonly selection: Input },
>(
  raw: unknown,
  options: ExecutionOptions | undefined,
  spec: {
    readonly operation: string;
    readonly input: z.ZodType<Input>;
    readonly report: z.ZodType<Report>;
    readonly run: (
      input: Input,
    ) => Promise<Result<AnalysisExecution, AnalysisError>>;
    readonly subject: (
      report: Report,
      input: Input,
    ) => FileIdentity | undefined;
    readonly invalidOutput: string;
  },
): Promise<Result<Evidence, AnalysisError>> => {
  const input = parseAnalysisInput(
    spec.operation,
    raw,
    spec.input,
    options?.signal,
  );
  if (!input.ok) return input;
  const decoded = await spec.run(input.value);
  if (!decoded.ok) return decoded;
  const execution = decoded.value;
  const report = spec.report.safeParse(execution.result);
  if (report.success) {
    const subject = spec.subject(report.data, input.value);
    if (
      subject !== undefined &&
      execution.subject?.path === subject.path &&
      execution.subject.sha256 === subject.sha256 &&
      JSON.stringify(report.data.selection) === JSON.stringify(input.value)
    )
      return completeProviderEvidence(
        createAnalysisExecutionEvidence(
          spec.operation,
          input.value,
          execution,
          "observed",
        ),
        options?.signal,
      );
  }
  return err(new AnalysisOutputError(spec.operation, spec.invalidOutput));
};
