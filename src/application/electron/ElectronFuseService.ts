import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { ElectronFusePort } from "../../ports/electron/ElectronFusePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  DEFAULT_INSPECT_ELECTRON_FUSES_DECODED_BYTES,
  DEFAULT_INSPECT_ELECTRON_FUSES_FILE_BYTES,
  DEFAULT_INSPECT_ELECTRON_FUSES_SENTINELS_PER_SLICE,
  electronFuseReportSchema,
  estimateElectronFuseDecodedBytes,
  inspectElectronFusesInputSchema,
  type InspectElectronFusesRequest,
} from "../../domain/electron/electronFuses.js";
import type { Evidence } from "../../domain/evidence.js";
import { createElectronFuseEvidence } from "../../domain/electron/electronFuseEvidence.js";
import type { Result } from "../../domain/result.js";
import { callerAnalysisParameters } from "../AnalysisInput.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_electron_fuses";

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class ElectronFuseService {
  constructor(readonly provider: ElectronFusePort) {}

  /** Await and retry the reader's exact retained descriptor owners. */
  async close(): Promise<void> {
    await this.provider.close();
  }

  /** Read fuse wires for one explicitly selected path without launching it. */
  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectElectronFusesInputSchema,
        outputSchema: electronFuseReportSchema,
        provider: this.provider,
        invalidOutputMessage:
          "Electron fuse reader returned a malformed report, changed the selected artifact identity, or exceeded the requested file, sentinel, or decoded-byte budget.",
        toParameters: (input): InspectElectronFusesRequest => ({
          ...callerAnalysisParameters(rawInput)(input),
          path: input.path,
        }),
        validateReport: (report, parameters) =>
          report.artifact.selected_path === parameters.path &&
          report.artifact.bytes <=
            (parameters.max_file_bytes ??
              DEFAULT_INSPECT_ELECTRON_FUSES_FILE_BYTES) &&
          report.slices.every(
            (slice) =>
              slice.sentinel_count <=
              (parameters.max_sentinels_per_slice ??
                DEFAULT_INSPECT_ELECTRON_FUSES_SENTINELS_PER_SLICE),
          ) &&
          estimateElectronFuseDecodedBytes(report.slices) <=
            (parameters.max_decoded_bytes ??
              DEFAULT_INSPECT_ELECTRON_FUSES_DECODED_BYTES),
        buildEvidence: (report, identity, parameters) =>
          createElectronFuseEvidence(parameters, report, identity),
      },
      rawInput,
      options,
    );
  }
}
