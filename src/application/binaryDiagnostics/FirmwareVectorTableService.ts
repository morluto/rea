import { sha256Hex } from "../../kernel/sha256Hex.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { FirmwareVectorTablePort } from "../../ports/binaryDiagnostics/FirmwareVectorTablePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  firmwareVectorTableSchema,
  vectorTableCountsMatch,
  inspectFirmwareVectorTableInputSchema,
  type FirmwareVectorTable,
  type InspectFirmwareVectorTableInput,
} from "../../domain/firmware/firmwareVectorTable.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_firmware_vector_table";

const validVectorReport = (
  report: FirmwareVectorTable,
  input: InspectFirmwareVectorTableInput,
): boolean => {
  if (report.artifact.path !== input.path) return false;
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.architecture !== input.architecture) return false;
  if (report.vector_table_offset !== input.vector_table_offset) return false;
  if (report.examined_entries > input.max_entries) return false;
  if (report.table_file_range.end > report.artifact.bytes) return false;
  if ((input.architecture === "riscv") !== (report.riscv_table_shape !== null))
    return false;
  if (input.architecture === "riscv" && report.reset_code_address !== null)
    return false;
  if (input.architecture !== "riscv" && report.trap_entry_address !== null)
    return false;
  return vectorTableCountsMatch(report);
};

/** Shared caller validation, output parsing, and Evidence provenance for CLI/MCP. */
export class FirmwareVectorTableService {
  constructor(readonly provider: FirmwareVectorTablePort) {}

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
        inputSchema: inspectFirmwareVectorTableInputSchema,
        outputSchema: firmwareVectorTableSchema,
        provider: this.provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "Firmware vector table provider returned malformed output or mismatched artifact identity.",
        toParameters: (input) => input,
        validateReport: validVectorReport,
        buildEvidence: (value, identity, parameters) => {
          const selected = callerAnalysisParameters(rawInput)(parameters);
          const { svd_xml, ...restParams } = selected;
          const evidenceParams =
            svd_xml === undefined
              ? restParams
              : {
                  ...restParams,
                  svd_xml_sha256: sha256Hex(svd_xml),
                };
          const limitations =
            svd_xml === undefined
              ? value.limitations
              : [
                  ...value.limitations,
                  "Inline svd_xml UTF-8 text is not retained in Evidence and is unavailable from this record; parameters.svd_xml_sha256 records the SHA-256 digest of the caller-supplied svd_xml.",
                ];
          return createEvidence(
            {
              path: value.artifact.path,
              format: "file",
              sha256: value.artifact.sha256,
            },
            identity,
            {
              operation: OPERATION,
              parameters: evidenceParams,
              result: value,
              confidence: "derived",
              limitations,
              locations: [
                { kind: "artifact-path", path: value.artifact.path },
                {
                  kind: "file-offset-range",
                  start: value.table_file_range.start,
                  end: value.table_file_range.end,
                },
              ],
            },
          );
        },
      },
      rawInput,
      options,
    );
  }
}
