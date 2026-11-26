import {
  inspectPacketFieldsInputSchema,
  packetFieldsCatalogSchema,
} from "../../domain/captures/packetFields.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  inspectPacketCaptureInputSchema,
  packetCaptureSchema,
} from "../../domain/captures/packetCapture.js";
import type { Result } from "../../domain/result.js";
import type { PacketCapturePort } from "../../ports/captures/PacketCapturePort.js";
import {
  executeRecordingInspection,
  selectedRecording,
} from "../RecordingInspection.js";

/** One shared validation and Evidence owner for CLI and MCP. */
export class PacketCaptureService {
  constructor(readonly provider: PacketCapturePort) {}
  close(): Promise<void> {
    return this.provider.close();
  }
  inspect(
    raw: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeRecordingInspection(raw, options, {
      operation: "inspect_packet_capture",
      input: inspectPacketCaptureInputSchema,
      report: packetCaptureSchema,
      run: (input) => this.provider.inspect(input, options),
      subject: selectedRecording,
      invalidOutput:
        "Capture analyzer returned malformed data or changed the selected artifact identity/options.",
    });
  }
  inspectFields(
    raw: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeRecordingInspection(raw, options, {
      operation: "inspect_packet_fields",
      input: inspectPacketFieldsInputSchema,
      report: packetFieldsCatalogSchema,
      run: (input) => this.provider.inspectFields(input, options),
      subject: (report) => report.tool,
      invalidOutput:
        "Field discovery returned malformed data or changed the selected installation/options.",
    });
  }
}
