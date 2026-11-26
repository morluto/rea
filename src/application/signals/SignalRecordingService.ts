import {
  inspectSignalDecodersInputSchema,
  signalDecodersSchema,
} from "../../domain/signals/signalDecoders.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  decodeSignalRecordingInputSchema,
  signalRecordingSchema,
} from "../../domain/signals/signalRecording.js";
import type { Result } from "../../domain/result.js";
import type { SignalRecordingPort } from "../../ports/signals/SignalRecordingPort.js";
import {
  executeRecordingInspection,
  selectedRecording,
} from "../RecordingInspection.js";

/** One shared validation and Evidence owner for CLI and MCP. */
export class SignalRecordingService {
  constructor(readonly provider: SignalRecordingPort) {}
  close(): Promise<void> {
    return this.provider.close();
  }
  decode(
    raw: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeRecordingInspection(raw, options, {
      operation: "decode_signal_recording",
      input: decodeSignalRecordingInputSchema,
      report: signalRecordingSchema,
      run: (input) => this.provider.decode(input, options),
      subject: selectedRecording,
      invalidOutput:
        "Decoder returned malformed data or changed the selected recording identity/options.",
    });
  }
  inspectDecoders(
    raw: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeRecordingInspection(raw, options, {
      operation: "inspect_signal_decoders",
      input: inspectSignalDecodersInputSchema,
      report: signalDecodersSchema,
      run: (input) => this.provider.inspectDecoders(input, options),
      subject: (report) => report.tool,
      invalidOutput:
        "Decoder discovery returned malformed data or changed the selected installation/options.",
    });
  }
}
