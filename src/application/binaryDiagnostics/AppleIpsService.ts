import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AppleIpsPort } from "../../ports/binaryDiagnostics/AppleIpsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  appleIpsSchema,
  appleIpsReportIntegerTextBytes,
  inspectAppleIpsInputSchema,
  type AppleIps,
} from "../../domain/native/appleIps.js";
import type { Result } from "../../domain/result.js";
import { observedFileEvidence } from "../observedFileEvidence.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_apple_ips";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class AppleIpsService {
  constructor(readonly provider: AppleIpsPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectAppleIpsInputSchema,
        outputSchema: appleIpsSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Apple IPS provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters),
        buildEvidence: (value, identity, parameters) =>
          observedFileEvidence(
            value,
            identity,
            OPERATION,
            parameters,
            value.join === null || value.join.path === value.artifact.path
              ? []
              : [{ kind: "artifact-path", path: value.join.path }],
          ),
      },
      rawInput,
      options,
    );
  }
}

const validReport = (
  report: AppleIps,
  input: InspectAppleIpsInputLike,
): boolean => {
  if (
    (input.join_path === undefined
      ? report.join !== null
      : report.join === null ||
        report.join.path !== input.join_path ||
        report.join.bytes > input.max_join_bytes) ||
    report.artifact.bytes > input.max_file_bytes ||
    report.coverage.threads > input.max_threads ||
    report.coverage.frames > input.max_frames ||
    report.coverage.images > input.max_images ||
    report.coverage.registers > input.max_registers ||
    report.coverage.threads !== report.threads.length ||
    report.coverage.images !== report.images.length
  )
    return false;
  const faultingThread = report.faulting_thread;
  const mismatches = report.coverage.type_mismatches;
  if (
    faultingThread !== null &&
    (report.threads[faultingThread]?.index !== faultingThread ||
      mismatches.some(
        ({ path }) => path === `body.threads[${String(faultingThread)}]`,
      )) &&
    !mismatches.some(({ path }) => path === "body.faultingThread")
  )
    return false;
  let frames = 0;
  let registers = 0;
  for (const thread of report.threads) {
    frames += thread.frames.length;
    registers += thread.registers.length;
  }
  return (
    frames === report.coverage.frames &&
    registers === report.coverage.registers &&
    appleIpsReportIntegerTextBytes(report) <= input.max_integer_text_bytes &&
    (report.coverage.status === "complete") ===
      (report.coverage.type_mismatches.length === 0)
  );
};

type InspectAppleIpsInputLike = {
  readonly join_path?: string | undefined;
  readonly max_join_bytes: number;
  readonly max_file_bytes: number;
  readonly max_threads: number;
  readonly max_frames: number;
  readonly max_images: number;
  readonly max_registers: number;
  readonly max_integer_text_bytes: number;
};
