import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { InspectSignalDecodersInput } from "../../domain/signals/signalDecoders.js";
import type { DecodeSignalRecordingInput } from "../../domain/signals/signalRecording.js";
import type { Result } from "../../domain/result.js";

export interface SignalRecordingPort {
  /** Release per-call resources before returning, or retain failed cleanup for close/retry. */
  decode(
    input: DecodeSignalRecordingInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
  inspectDecoders(
    input: InspectSignalDecodersInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
  close(): Promise<void>;
}
