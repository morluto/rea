import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { CanonicalizePort } from "./CanonicalizePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  canonicalizeArtifactInputSchema,
  canonicalizeArtifactSchema,
} from "../../domain/canonicalize/canonicalizeArtifact.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "canonicalize_artifact";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class CanonicalizeService {
  constructor(readonly provider: CanonicalizePort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async canonicalize(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      canonicalizeArtifactInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.canonicalize(input.value, options);
    if (!result.ok) return result;
    const report = canonicalizeArtifactSchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      report.data.artifact.bytes > input.value.max_file_bytes ||
      report.data.requested_format !== input.value.format
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Canonicalizer returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "file",
          sha256: value.artifact.sha256,
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.value,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [{ kind: "artifact-path", path: value.artifact.path }],
        },
      ),
      options?.signal,
    );
  }
}
