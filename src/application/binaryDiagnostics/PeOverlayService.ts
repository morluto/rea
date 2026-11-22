import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { PeOverlayPort } from "../../ports/binaryDiagnostics/PeOverlayPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectPeOverlayInputSchema,
  peOverlaySchema,
} from "../../domain/native/peOverlay.js";
import { peSubjectArchitecture } from "../../domain/peMachine.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "inspect_pe_overlay";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class PeOverlayService {
  constructor(readonly provider: PeOverlayPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectPeOverlayInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const result = await this.provider.inspect(input.value, options);
    if (!result.ok) return result;
    const report = peOverlaySchema.safeParse(result.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      report.data.artifact.bytes > input.value.max_file_bytes
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "PE overlay provider returned malformed output or changed artifact identity.",
        ),
      );
    const value = report.data;
    const architecture = peSubjectArchitecture(value.machine, value.format);
    const locations = [
      { kind: "artifact-path" as const, path: value.artifact.path },
      ...value.ranges.map((range) => ({
        kind: "file-offset-range" as const,
        start: range.offset,
        end: range.offset + range.size,
      })),
    ];
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          format: "pe",
          sha256: value.artifact.sha256,
          ...(architecture === undefined ? {} : { architecture }),
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.value,
          result: value,
          confidence: "derived",
          limitations: value.limitations,
          locations,
        },
      ),
      options?.signal,
    );
  }
}
