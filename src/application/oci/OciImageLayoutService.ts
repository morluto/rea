import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { OciImageLayoutPort } from "../../ports/oci/OciImageLayoutPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import { recognizeEvidence } from "../../domain/evidenceValidation.js";
import {
  inspectOciImageLayoutInputSchema,
  ociImageLayoutSchema,
  type OciImageLayout,
} from "../../domain/oci/imageLayout.js";
import {
  createOciImageLayoutEvidence,
  INSPECT_OCI_IMAGE_LAYOUT_OPERATION,
} from "../../domain/oci/imageLayoutEvidence.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";

const OPERATION = INSPECT_OCI_IMAGE_LAYOUT_OPERATION;

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
    const evidenceFor = (report: OciImageLayout) =>
      createOciImageLayoutEvidence(
        this.provider.identity,
        selectedParameters(input.value),
        report,
      );
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok)
      return err(
        withCallerEvidence(result.error, input.value.path, evidenceFor),
      );
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
    return completeProviderEvidence(evidenceFor(report.data), options?.signal);
  }
}

/**
 * The provider sees resolved defaults, so a completed inventory it keeps on a
 * cleanup failure names them as parameters. Rebuild that Evidence from the
 * caller's own selections, matching the success path.
 */
const withCallerEvidence = (
  error: AnalysisError,
  path: string,
  evidenceFor: (report: OciImageLayout) => Evidence,
): AnalysisError => {
  const seen = new Set<AnalysisError>();
  let current: AnalysisError | undefined = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const recognized = recognizeEvidence(current.partialObservation);
    if (recognized.ok && recognized.value?.operation === OPERATION) {
      const report = ociImageLayoutSchema.safeParse(
        recognized.value.normalized_result,
      );
      if (report.success && report.data.artifact.path === path)
        current.partialObservation = evidenceFor(report.data);
    }
    current = current.cleanupPrimary;
  }
  return error;
};

const validReport = (
  report: OciImageLayout,
  input: {
    readonly max_json_bytes: number;
    readonly max_blob_bytes: number;
    readonly max_entries: number;
    readonly max_descriptors: number;
    readonly max_index_depth: number;
  },
): boolean => {
  // The report does not count document reads, and failed or truncated
  // manifests and nested indexes are read without appearing in it. Every
  // nested index or manifest read is charged one descriptor, and each
  // manifest reads at most one config, so oci-layout, index.json and two
  // documents per descriptor bound how many JSON documents were read.
  if (
    report.coverage.entries_examined > input.max_entries ||
    report.coverage.json_bytes_read >
      input.max_json_bytes * (2 + 2 * input.max_descriptors)
  )
    return false;
  if (report.indexes.some((index) => index.depth > input.max_index_depth))
    return false;
  return report.artifact.format === "directory";
};
