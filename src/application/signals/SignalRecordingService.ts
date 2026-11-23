import {
  inspectSignalDecodersInputSchema,
  signalDecodersSchema,
} from "../../domain/signals/signalDecoders.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { createAnalysisExecutionEvidence } from "../../domain/analysisObservation.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  decodeSignalRecordingInputSchema,
  signalRecordingSchema,
} from "../../domain/signals/signalRecording.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import type { SignalRecordingPort } from "../../ports/signals/SignalRecordingPort.js";

/** One shared validation and Evidence owner for CLI and MCP. */
export class SignalRecordingService {
  constructor(readonly provider: SignalRecordingPort) {}
  close(): Promise<void> {
    return this.provider.close();
  }
  async decode(
    raw: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "decode_signal_recording";
    const input = parseAnalysisInput(
      operation,
      raw,
      decodeSignalRecordingInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const decoded = await this.provider.decode(input.value, options);
    if (!decoded.ok) return decoded;
    const execution = decoded.value;
    const report = signalRecordingSchema.safeParse(execution.result);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      execution.subject?.path !== input.value.path ||
      execution.subject.sha256 !== report.data.artifact.sha256 ||
      JSON.stringify(report.data.selection) !== JSON.stringify(input.value)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Decoder returned malformed data or changed the selected recording identity/options.",
        ),
      );
    return completeProviderEvidence(
      createAnalysisExecutionEvidence(
        operation,
        input.value,
        execution,
        "observed",
      ),
      options?.signal,
    );
  }
  async inspectDecoders(
    raw: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_signal_decoders";
    const input = parseAnalysisInput(
      operation,
      raw,
      inspectSignalDecodersInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const decoded = await this.provider.inspectDecoders(input.value, options);
    if (!decoded.ok) return decoded;
    const execution = decoded.value;
    const report = signalDecodersSchema.safeParse(execution.result);
    if (
      !report.success ||
      JSON.stringify(report.data.selection) !== JSON.stringify(input.value) ||
      execution.subject?.path !== report.data.tool.path ||
      execution.subject.sha256 !== report.data.tool.sha256
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Decoder discovery returned malformed data or changed the selected installation/options.",
        ),
      );
    return completeProviderEvidence(
      createAnalysisExecutionEvidence(
        operation,
        input.value,
        execution,
        "observed",
      ),
      options?.signal,
    );
  }
}
