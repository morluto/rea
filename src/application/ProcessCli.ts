import { readFile } from "node:fs/promises";

import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { createEvidence, parseEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { processTraceSpecificationSchema } from "../domain/processTraceComparison.js";
import { processScenarioSchema } from "../domain/processScenario.js";
import {
  compareProcessCaptures,
  parseProcessCapture,
} from "../domain/processCapture.js";
import { captureProcessScenario } from "./ProcessHarness.js";
import {
  PROCESS_PROVIDER,
  createProcessCaptureEvidence,
} from "./ProcessEvidence.js";

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
) => {
  try {
    const input = await readJson(path);
    const parsed = processScenarioSchema.safeParse(input);
    if (!parsed.success)
      throw new AnalysisInputError(
        "capture_process_scenario",
        { cause: parsed.error },
        projectInputIssues(parsed.error.issues, input),
      );
    const captured = await captureProcessScenario(
      parsed.data,
      undefined,
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
    throw invalidCaptureEvidence();
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
    throw invalidCaptureEvidence();
  }
};

const parseTraceSpecification = (input: unknown) => {
  const parsed = processTraceSpecificationSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new AnalysisInputError(
    "compare-process-captures",
    { cause: parsed.error },
    projectInputIssues(parsed.error.issues, input),
  );
};

const invalidCaptureEvidence = (): ProcessCliFailure =>
  new ProcessCliFailure(
    "invalid_input",
    "Capture evidence is malformed. Create new capture evidence, then try again.",
  );

const readJson = async (path: string): Promise<unknown> => {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (cause: unknown) {
    void cause;
    throw new ProcessCliFailure(
      "invalid_input",
      "Process input file could not be read. Check that the path exists and is readable.",
    );
  }
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (cause: unknown) {
    void cause;
    throw new ProcessCliFailure(
      "invalid_input",
      "Process input file is not valid JSON. Repair the file, then try again.",
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

/** Project any process CLI failure without exposing its cause. */
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
    message:
      "Process command could not complete. Check the input files and run `rea doctor`, then try again.",
  };
};
