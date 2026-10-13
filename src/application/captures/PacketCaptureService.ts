import {
  inspectPacketFieldsInputSchema,
  packetFieldsCatalogSchema,
  type InspectPacketFieldsInput,
} from "../../domain/captures/packetFields.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { isAbsolute } from "node:path";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  inspectPacketCaptureInputSchema,
  packetCaptureSchema,
  type InspectPacketCaptureInput,
} from "../../domain/captures/packetCapture.js";
import { err, ok, type Result } from "../../domain/result.js";

export interface PacketCapturePort {
  /** Release per-call resources before returning, or retain failed cleanup for close/retry. */
  inspect(
    input: InspectPacketCaptureInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
  inspectFields(
    input: InspectPacketFieldsInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
  close(): Promise<void>;
}

/** One shared validation and Evidence owner for CLI and MCP. */
export class PacketCaptureService {
  constructor(readonly provider: PacketCapturePort) {}
  close(): Promise<void> {
    return this.provider.close();
  }
  async inspect(
    raw: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_packet_capture";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = inspectPacketCaptureInputSchema.safeParse(raw);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, raw, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute local path.",
          },
        ]),
      );
    const decoded = await this.provider.inspect(input.data, options);
    if (!decoded.ok) return decoded;
    const execution = decoded.value;
    const report = packetCaptureSchema.safeParse(execution.result);
    if (
      !report.success ||
      report.data.artifact.path !== input.data.path ||
      execution.subject?.path !== input.data.path ||
      execution.subject.sha256 !== report.data.artifact.sha256 ||
      JSON.stringify(report.data.selection) !== JSON.stringify(input.data)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Capture analyzer returned malformed data or changed the selected artifact identity/options.",
        ),
      );
    return this.#evidence(operation, input.data, execution, options);
  }
  async inspectFields(
    raw: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_packet_fields";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = inspectPacketFieldsInputSchema.safeParse(raw);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, raw, {
          cause: input.error,
        }),
      );
    const decoded = await this.provider.inspectFields(input.data, options);
    if (!decoded.ok) return decoded;
    const execution = decoded.value;
    const report = packetFieldsCatalogSchema.safeParse(execution.result);
    if (
      !report.success ||
      JSON.stringify(report.data.selection) !== JSON.stringify(input.data) ||
      execution.subject?.path !== report.data.tool.path ||
      execution.subject.sha256 !== report.data.tool.sha256
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Field discovery returned malformed data or changed the selected installation/options.",
        ),
      );
    return this.#evidence(operation, input.data, execution, options);
  }
  #evidence(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    execution: AnalysisExecution,
    options?: ExecutionOptions,
  ): Result<Evidence, AnalysisError> {
    const evidence = createEvidence(
      execution.subject ?? undefined,
      execution.provider,
      {
        operation,
        parameters,
        result: execution.result,
        confidence: "observed",
        locations: execution.locations,
        limitations: execution.limitations,
      },
    );
    return options?.signal?.aborted
      ? err(
          new AnalysisCancelledError(operation, {
            partialObservation: evidence,
          }),
        )
      : ok(evidence);
  }
}
