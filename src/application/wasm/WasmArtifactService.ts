import type { AnalysisSettingsReader } from "../../domain/analysisSettings.js";
import { constants as bufferConstants } from "node:buffer";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  analysisExecutionEnvelopeForAdmission,
  createAnalysisExecutionEvidence,
} from "../../domain/analysisObservation.js";
import type { WasmArtifactPort } from "./WasmArtifactPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  inspectWasmArtifactInputSchema,
  wasmArtifactSchema,
  wasmArtifactMatchesSubject,
  DEFAULT_WASM_COMMAND_TIMEOUT_MS,
  DEFAULT_WASM_ARTIFACT_PATHS,
  MAX_WASM_ARTIFACT_PATHS,
  wasmResourceLimits,
} from "../../domain/wasm/wasmArtifact.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { requireAuthenticationHeadroom } from "../JsonAuthenticationHeadroom.js";

const OPERATION = "inspect_wasm_artifact";

/** Shared artifact validation and typed inline Evidence for CLI/MCP. */
export class WasmArtifactService {
  constructor(
    readonly provider: WasmArtifactPort,
    readonly settings?: AnalysisSettingsReader,
  ) {}

  /** Join provider cleanup during shutdown or an explicit retry. */
  close(): Promise<void> {
    return this.provider.close();
  }

  /** Preserve exact selected artifact identity and validated upstream observations. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectWasmArtifactInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const maximumPaths =
      input.value.max_artifact_paths ?? DEFAULT_WASM_ARTIFACT_PATHS;
    for (const field of ["glue_paths", "candidate_paths"] as const) {
      if (input.value[field].length > maximumPaths)
        return err(
          new AnalysisResourceConstraintError(
            OPERATION,
            "capacity",
            `${field} exceeds max_artifact_paths (${String(maximumPaths)} paths)`,
            {
              maximum_paths: maximumPaths,
              default_paths: DEFAULT_WASM_ARTIFACT_PATHS,
              source:
                input.value.max_artifact_paths === undefined
                  ? "default"
                  : "request",
              selected_paths: input.value[field].length,
              input_field: field,
            },
            {
              retryable: false,
              remediationAction: `Raise max_artifact_paths to at least ${String(input.value[field].length)} (maximum ${String(MAX_WASM_ARTIFACT_PATHS)}), or use --max-artifact-paths on the CLI; then retry the same selection. The value applies on the next inspection without restart. File and command byte budgets remain independent.`,
            },
          ),
        );
    }
    const timeout =
      input.value.command_timeout_ms ??
      this.settings?.().overrides["wasm.command_timeout_ms"] ??
      DEFAULT_WASM_COMMAND_TIMEOUT_MS;
    const inspected = await this.provider.inspect(input.value, {
      ...options,
      commandTimeoutMs: timeout,
    });
    if (!inspected.ok) return inspected;
    const execution = inspected.value;
    const admission = requireAuthenticationHeadroom(
      analysisExecutionEnvelopeForAdmission(
        OPERATION,
        input.value,
        execution,
        "observed",
      ),
      {
        operation: OPERATION,
        path: input.value.path,
        description: "Complete WASM Evidence cannot be assembled",
        serializedCodeUnitLimit: bufferConstants.MAX_STRING_LENGTH,
      },
    );
    if (!admission.ok) return admission;
    const report = wasmArtifactSchema.safeParse(execution.result);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      execution.subject.path !== input.value.path ||
      report.data.tool_profile.timeout_ms !== timeout ||
      report.data.tool_profile.output_budget_bytes !==
        wasmResourceLimits(input.value).outputBytes ||
      !wasmArtifactMatchesSubject(report.data.artifact, execution.subject) ||
      JSON.stringify(report.data.glue.map((item) => item.artifact.path)) !==
        JSON.stringify(input.value.glue_paths) ||
      JSON.stringify(report.data.candidates.map((item) => item.path)) !==
        JSON.stringify([
          ...new Set([input.value.path, ...input.value.candidate_paths]),
        ])
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "WABT adapter returned malformed data or changed the selected artifact identity.",
        ),
      );
    return completeProviderEvidence(
      createAnalysisExecutionEvidence(
        OPERATION,
        input.value,
        { ...execution, result: report.data },
        "observed",
      ),
      options?.signal,
    );
  }
}
