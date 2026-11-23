import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { PythonPycPort } from "../../ports/python/PythonPycPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectPythonPycInputSchema,
  PYTHON_PYC_HEADER_BYTES,
  pythonPycSchema,
} from "../../domain/python/pythonPyc.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_python_pyc";

/** Shared caller validation, output parsing and Evidence provenance for CLI and MCP. */
export class PythonPycService {
  constructor(readonly provider: PythonPycPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectPythonPycInputSchema,
        outputSchema: pythonPycSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Python pyc provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          report.artifact.bytes <= parameters.max_file_bytes &&
          report.coverage.objects <= parameters.max_objects &&
          report.coverage.marshal_depth <= parameters.max_depth,
        buildEvidence: (value, identity, parameters) =>
          createEvidence(
            {
              path: value.artifact.path,
              format: "file",
              sha256: value.artifact.sha256,
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
                {
                  kind: "file-offset-range",
                  start: 0,
                  end: PYTHON_PYC_HEADER_BYTES,
                },
                {
                  kind: "file-offset-range",
                  start: PYTHON_PYC_HEADER_BYTES,
                  end: value.artifact.bytes,
                },
              ],
            },
          ),
      },
      rawInput,
      options,
    );
  }
}
