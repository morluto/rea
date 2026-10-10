import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { WasmArtifactPort } from "./WasmArtifactPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectWasmArtifactInputSchema,
  wasmArtifactSchema,
} from "../../domain/wasm/wasmArtifact.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_wasm_artifact";

/** Shared artifact validation and typed inline Evidence for CLI/MCP. */
export class WasmArtifactService {
  constructor(readonly provider: WasmArtifactPort) {}

  /** Preserve exact selected artifact identity and validated upstream observations. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const input = inspectWasmArtifactInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (
      ![
        input.data.path,
        ...input.data.glue_paths,
        ...input.data.candidate_paths,
      ].every(isAbsolute)
    )
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const inspected = await this.provider.inspect(input.data, options);
    if (!inspected.ok) return inspected;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const execution = inspected.value;
    const report = wasmArtifactSchema.safeParse(execution.result);
    if (
      !report.success ||
      report.data.artifact.path !== input.data.path ||
      execution.subject?.path !== input.data.path ||
      execution.subject.sha256 !== report.data.artifact.sha256 ||
      createHash("sha256").update(report.data.wat.text).digest("hex") !==
        report.data.wat.sha256 ||
      JSON.stringify(report.data.glue.map((item) => item.artifact.path)) !==
        JSON.stringify(input.data.glue_paths) ||
      JSON.stringify(report.data.candidates.map((item) => item.path)) !==
        JSON.stringify([
          ...new Set([input.data.path, ...input.data.candidate_paths]),
        ])
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "WABT adapter returned malformed data or changed the selected artifact identity.",
        ),
      );
    return ok(
      createEvidence(execution.subject, execution.provider, {
        operation: OPERATION,
        parameters: input.data,
        result: report.data,
        ...(execution.rawResult === null
          ? {}
          : { rawResult: execution.rawResult }),
        confidence: "observed",
        locations: execution.locations,
        limitations: execution.limitations,
      }),
    );
  }
}
