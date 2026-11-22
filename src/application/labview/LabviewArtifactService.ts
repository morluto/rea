import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { LabviewArtifactPort } from "../../ports/labview/LabviewArtifactPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectLabviewArtifactInputSchema,
  labviewArtifactSchema,
} from "../../domain/labview/labviewArtifact.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_labview_artifact";

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class LabviewArtifactService {
  constructor(readonly provider: LabviewArtifactPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  /** Inspect one explicitly selected file without acquiring a binary session. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectLabviewArtifactInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const inspected = await this.provider.inspect(input.value, options);
    if (!inspected.ok) return inspected;
    const report = labviewArtifactSchema.safeParse(inspected.value);
    if (!report.success || report.data.artifact.path !== input.value.path)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "LabVIEW RSRC reader returned malformed output or changed the selected artifact identity.",
        ),
      );
    const value = report.data;
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          sha256: value.artifact.sha256,
          format: "file",
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
