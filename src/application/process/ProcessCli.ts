import { readFile } from "node:fs/promises";
import { z } from "zod";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { createEvidence, parseEvidence } from "../../domain/evidence.js";
import { describeValidationFailure } from "../../domain/evidenceBundle.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import {
  analysisInputErrorFromIssues,
  projectInputIssues,
} from "../../domain/inputIssueProjection.js";
import { processTraceSpecificationSchema } from "../../domain/process/processTraceSpecification.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { compareProcessCaptures } from "../../domain/process/processComparison.js";
import { parseProcessCapture } from "../../domain/process/processCaptureParsing.js";
import { captureProcessScenario } from "../../process/capture/ProcessHarness.js";
import { PROCESS_PROVIDER } from "../../domain/process/processEvidenceProvider.js";
import { createProcessCaptureEvidence } from "./ProcessEvidence.js";
import { JSON_BYTE_ORDER_MARK_MESSAGE } from "../Utf8JsonInput.js";

/** Safe process-command failure returned to the CLI adapter. */
export interface ProcessCliErrorOutput {
  readonly error: "Process command failed";
  readonly category: string;
  readonly message: string;
}

/** Identify the process workflow's typed diagnostic result for CLI exit status. */
export const isProcessCliFailure = (
  value: unknown,
): value is ProcessCliErrorOutput =>
  typeof value === "object" &&
  value !== null &&
  "error" in value &&
  value.error === "Process command failed" &&
  "category" in value &&
  typeof value.category === "string" &&
  "message" in value &&
  typeof value.message === "string";

/** Capture one JSON scenario through the shared process harness and Evidence contract. */
export const captureProcessScenarioFile = async (
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  signal?: AbortSignal,
) => {
  try {
    const input = await readJson(path);
    const parsed = processScenarioSchema.safeParse(input);
    if (!parsed.success)
      throw analysisInputErrorFromIssues(
        "capture_process_scenario",
        parsed.error.issues,
        input,
        { cause: parsed.error },
      );
    const captured = await captureProcessScenario(
      parsed.data,
      signal,
      process.platform,
      environment,
    );
    if (!captured.ok) return cliAnalysisError(captured.error);
    return createProcessCaptureEvidence(parsed.data, captured.value);
  } catch (cause: unknown) {
    return projectProcessCliError(cause);
  }
};

/** Compare two capture Evidence files and emit derived comparison Evidence. */
export const compareProcessEvidenceFiles = async (
  leftPath: string,
  rightPath: string,
  traceSpecPath?: string,
) => {
  try {
    const left = parseCaptureEvidence(await readJson(leftPath));
    const right = parseCaptureEvidence(await readJson(rightPath));
    const traceSpecification =
      traceSpecPath === undefined
        ? undefined
        : parseTraceSpecification(await readJson(traceSpecPath));
    const comparison =
      traceSpecification === undefined
        ? compareProcessCaptures(left.capture, right.capture)
        : compareProcessCaptures(left.capture, right.capture, {
            traceSpecification,
          });
    return createEvidence(undefined, PROCESS_PROVIDER, {
      predicateType: "rea.process-comparison",
      operation: "compare_process_captures",
      parameters: {
        left_evidence_id: left.id,
        right_evidence_id: right.id,
        left_normalization: left.capture.normalization,
        right_normalization: right.capture.normalization,
        ...(traceSpecification === undefined
          ? {}
          : { trace_spec: jsonValueSchema.parse(traceSpecification) }),
      },
      result: jsonValueSchema.parse(comparison),
      confidence: "derived",
      authority: "analyst-inference",
      limitations: comparison.limitations,
      locations: [...left.locations, ...right.locations],
      evidenceLinks: [left.id, right.id],
    });
  } catch (cause: unknown) {
    return projectProcessCliError(cause);
  }
};

const parseCaptureEvidence = (input: unknown) => {
  let evidence;
  try {
    evidence = parseEvidence(input);
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      throw new AnalysisInputError(
        "compare_process_captures",
        { cause },
        projectInputIssues(cause.issues, input),
      );
    throw invalidCaptureEvidence(cause);
  }
  if (
    evidence.operation !== "capture_process_scenario" ||
    evidence.predicate_type !== "rea.process-capture" ||
    evidence.provider.id !== PROCESS_PROVIDER.id ||
    evidence.provider.version !== PROCESS_PROVIDER.version
  ) {
    throw new ProcessCliFailure(
      "invalid_input",
      "Capture evidence is not from the current process-capture workflow. Create new capture evidence, then try again.",
    );
  }
  try {
    return {
      id: evidence.evidence_id,
      capture: parseProcessCapture(evidence.normalized_result),
      locations: evidence.locations,
    };
  } catch (cause: unknown) {
    throw invalidCaptureEvidence(cause);
  }
};

const parseTraceSpecification = (input: unknown) => {
  const parsed = processTraceSpecificationSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  // Match the MCP boundary: the operation name and a trace_spec-rooted path.
  throw new AnalysisInputError(
    "compare_process_captures",
    { cause: parsed.error },
    projectInputIssues(parsed.error.issues, input).map((issue) => ({
      ...issue,
      path: ["trace_spec", ...issue.path],
    })),
  );
};

const invalidCaptureEvidence = (cause: unknown): ProcessCliFailure =>
  new ProcessCliFailure(
    "invalid_input",
    `Capture evidence is malformed (${describeValidationFailure(cause)}). Create new capture evidence, then try again.`,
  );

const readJson = async (path: string): Promise<unknown> => {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (cause: unknown) {
    throw new ProcessCliFailure(
      "invalid_input",
      `Process input file could not be read: ${path} (${describeValidationFailure(cause)}). Check the reported filesystem constraint and retry.`,
    );
  }
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (text.startsWith("\uFEFF"))
      throw new Error(JSON_BYTE_ORDER_MARK_MESSAGE);
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (cause: unknown) {
    throw new ProcessCliFailure(
      "invalid_input",
      `Process input file is not valid UTF-8 JSON: ${path} (${describeValidationFailure(cause)}). Repair the file, then try again.`,
    );
  }
};

class ProcessCliFailure extends Error {
  constructor(
    readonly category: string,
    readonly userMessage: string,
  ) {
    super(userMessage);
  }
}

const cliAnalysisError = (error: AnalysisError): ProcessCliErrorOutput => ({
  error: "Process command failed",
  ...projectAnalysisError(error),
});

/** Preserve typed failures and local diagnostics at the process CLI boundary. */
export const projectProcessCliError = (
  cause: unknown,
): ProcessCliErrorOutput => {
  if (cause instanceof ProcessCliFailure)
    return {
      error: "Process command failed",
      category: cause.category,
      message: cause.userMessage,
    };
  if (cause instanceof AnalysisError) return cliAnalysisError(cause);
  return {
    error: "Process command failed",
    category: "execution_failure",
    message: `Process command could not complete: ${describeValidationFailure(cause)}`,
  };
};
