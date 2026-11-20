import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { InspectPacketFieldsInput } from "../../domain/captures/packetFields.js";
import type { InspectPacketCaptureInput } from "../../domain/captures/packetCapture.js";
import type { Result } from "../../domain/result.js";

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
