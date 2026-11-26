import { sha256Hex } from "../../kernel/sha256Hex.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { FirmwareLiteralPoolsPort } from "../../ports/binaryDiagnostics/FirmwareLiteralPoolsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  firmwareLiteralPoolsReportSchema,
  inspectFirmwareLiteralPoolsInputSchema,
  type FirmwareLiteralPoolsReport,
  type InspectFirmwareLiteralPoolsInput,
} from "../../domain/firmware/firmwareLiteralPools.js";
import { validateLiteralPoolAddressAlignment } from "../../domain/firmware/firmwareLiteralPoolScanner.js";
import { err, type Result } from "../../domain/result.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_firmware_literal_pools";

const validLiteralPoolsReport = (
  report: FirmwareLiteralPoolsReport,
  input: InspectFirmwareLiteralPoolsInput,
): boolean => {
  if (report.artifact.path !== input.path) return false;
  if (report.isa !== input.isa) return false;
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.references.length > input.max_references) return false;
  if (report.references.length !== report.counts.resolved_pool_loads)
    return false;
  if (report.coverage.retained_references !== report.references.length)
    return false;
  if (report.coverage.omitted_references !== 0) return false;
  if (report.scan_range.scanned_bytes > input.max_scan_bytes) return false;
  if (report.scan_range.end > report.artifact.bytes) return false;
  return true;
};

/** Shared caller validation, output parsing, and Evidence provenance for CLI/MCP. */
export class FirmwareLiteralPoolsService {
  constructor(readonly provider: FirmwareLiteralPoolsPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsedInput = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectFirmwareLiteralPoolsInputSchema,
      options?.signal,
    );
    if (!parsedInput.ok) return parsedInput;
    const staticCheck = validateLiteralPoolAddressAlignment({
      isa: parsedInput.value.isa,
      baseAddressHex: parsedInput.value.base_address,
      scanOffset: parsedInput.value.scan_offset,
    });
    if (staticCheck.issues.length > 0) {
      return err(
        new AnalysisInputError(OPERATION, undefined, staticCheck.issues),
      );
    }

    const selectCallerParameters = callerAnalysisParameters(rawInput);
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectFirmwareLiteralPoolsInputSchema,
        outputSchema: firmwareLiteralPoolsReportSchema,
        provider: this.provider,
        retainCompletedReport: true,
        invalidOutputMessage:
          "Firmware literal-pools provider returned malformed output or mismatched artifact identity.",
        toParameters: (input) => input,
        validateReport: validLiteralPoolsReport,
        buildEvidence: (value, identity, parameters) => {
          const selected = selectCallerParameters(parameters);
          const { svd_xml, ...restSelected } = selected;
          const evidenceParams =
            svd_xml === undefined
              ? restSelected
              : {
                  ...restSelected,
                  svd_xml_sha256: sha256Hex(svd_xml),
                };
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
              limitations: value.limitations,
              locations: [
                { kind: "artifact-path", path: value.artifact.path },
                {
                  kind: "file-offset-range",
                  start: value.scan_range.start,
                  end: value.scan_range.end,
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
