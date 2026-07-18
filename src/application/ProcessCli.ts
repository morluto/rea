import { readFile } from "node:fs/promises";

import { parseConfig } from "../config.js";
import {
  AnalysisError,
  AnalysisProtocolError,
  PermissionRequiredError,
  projectAnalysisError,
} from "../domain/errors.js";
import { createEvidence, parseEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  compareProcessCaptures,
  LEGACY_PROCESS_CAPTURE_MESSAGE,
  parseProcessScenario,
  parseProcessCapture,
} from "../domain/processCapture.js";
import { captureProcessScenario } from "./ProcessHarness.js";
import { processCapturePermissionRequest } from "./ProcessCapturePermission.js";
import {
  PROCESS_PROVIDER,
  createProcessCaptureEvidence,
} from "./ProcessEvidence.js";
import { loadConfiguredPermissionAuthority } from "./PermissionConfiguration.js";

const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** Safe process-command failure returned to the CLI adapter. */
export interface ProcessCliErrorOutput {
  readonly error: "Process command failed";
  readonly category: string;
  readonly message: string;
}

/** Capture one JSON scenario through the same policy and evidence contract as MCP. */
export const captureProcessScenarioFile = async (path: string) => {
  try {
    const input = await readJson(path);
    let scenario;
    try {
      scenario = parseProcessScenario(input);
    } catch {
      throw new ProcessCliFailure(
        "invalid_input",
        "Process scenario is invalid. Check its required fields and limits, then try again.",
      );
    }
    const config = parseConfig(process.env);
    if (!config.ok) return cliAnalysisError(config.error);
    const authority = await loadConfiguredPermissionAuthority(config.value);
    if (!authority.ok) return cliAnalysisError(authority.error);
    const authorized = await authority.value.authorize(
      processCapturePermissionRequest(scenario),
      "read",
    );
    if (!authorized.ok)
      return cliAnalysisError(
        authorized.error instanceof PermissionRequiredError
          ? authorized.error
          : new AnalysisProtocolError(authorized.error.message, {
              cause: authorized.error,
            }),
      );
    const captured = await captureProcessScenario(
      scenario,
      config.value.processExecutionPolicy,
    );
    if (!captured.ok) return cliAnalysisError(captured.error);
    return createProcessCaptureEvidence(scenario, captured.value);
  } catch (cause: unknown) {
    return projectProcessCliError(cause);
  }
};

/** Compare two capture Evidence files and emit derived comparison Evidence. */
export const compareProcessEvidenceFiles = async (
  leftPath: string,
  rightPath: string,
) => {
  try {
    const left = parseCaptureEvidence(await readJson(leftPath));
    const right = parseCaptureEvidence(await readJson(rightPath));
    const comparison = compareProcessCaptures(left.capture, right.capture);
    return createEvidence(undefined, PROCESS_PROVIDER, {
      predicateType: "rea.process-comparison/v3",
      operation: "compare_process_captures",
      parameters: {
        left_evidence_id: left.id,
        right_evidence_id: right.id,
        left_normalization: left.capture.normalization,
        right_normalization: right.capture.normalization,
      },
      result: jsonValueSchema.parse(comparison),
      confidence: "derived",
      authority: "analyst-inference",
      limitations: comparison.limitations,
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
  } catch {
    throw invalidCaptureEvidence();
  }
  if (
    evidence.operation !== "capture_process_scenario" ||
    evidence.predicate_type !== "rea.process-capture/v4" ||
    evidence.provider.id !== PROCESS_PROVIDER.id ||
    evidence.provider.version !== PROCESS_PROVIDER.version
  ) {
    if (evidence.predicate_type === "rea.process-capture/v3")
      throw new ProcessCliFailure(
        "invalid_input",
        LEGACY_PROCESS_CAPTURE_MESSAGE,
      );
    throw new ProcessCliFailure(
      "invalid_input",
      "Capture evidence is not from the current process-capture workflow. Create new capture evidence, then try again.",
    );
  }
  try {
    return {
      id: evidence.evidence_id,
      capture: parseProcessCapture(evidence.normalized_result),
    };
  } catch {
    throw invalidCaptureEvidence();
  }
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
  } catch {
    throw new ProcessCliFailure(
      "invalid_input",
      "Process input file could not be read. Check that the path exists and is readable.",
    );
  }
  if (bytes.length > MAX_INPUT_BYTES)
    throw new ProcessCliFailure(
      "truncated",
      "Process input file is too large. Reduce it below 64 MiB, then try again.",
    );
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
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
