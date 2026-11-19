import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { OciImageLayoutPort } from "../../ports/oci/OciImageLayoutPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectOciImageLayoutInputSchema,
  ociImageLayoutSchema,
  type OciImageLayout,
} from "../../domain/oci/imageLayout.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";

const OPERATION = "inspect_oci_image_layout";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class OciImageLayoutService {
  constructor(readonly provider: OciImageLayoutPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const selectedParameters = callerAnalysisParameters(rawInput);
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectOciImageLayoutInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = ociImageLayoutSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !validReport(report.data, input.value)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "OCI image layout provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "directory",
          sha256: value.artifact.snapshot_sha256,
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: selectedParameters(input.value),
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [
            { kind: "artifact-path" as const, path: value.artifact.path },
          ],
        },
      ),
      options?.signal,
    );
  }
}

const validReport = (
  report: OciImageLayout,
  input: {
    readonly max_json_bytes: number;
    readonly max_blob_bytes: number;
    readonly max_entries: number;
    readonly max_index_depth: number;
  },
): boolean => {
  if (
    report.coverage.entries_examined > input.max_entries ||
    report.coverage.json_bytes_read >
      input.max_json_bytes *
        Math.max(1, report.indexes.length + report.images.length + 2)
  )
    return false;
  if (report.indexes.some((index) => index.depth > input.max_index_depth))
    return false;
  return report.artifact.format === "directory";
};
