import {
  inspectSignalDecodersInputSchema,
  signalDecodersSchema,
} from "../../domain/signals/signalDecoders.js";
import {
  decodeSignalRecordingInputSchema,
  signalRecordingSchema,
} from "../../domain/signals/signalRecording.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
export const SIGNAL_TOOL_CONTRACTS = [
  {
    name: "inspect_signal_decoders",
    ...toolContractMetadata("inspect_signal_decoders"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "List installed sigrok decoder IDs/names, or supply an exact decoder ID to inspect its channel/option help. Use returned IDs/options with decode_signal_recording. query matches a case-insensitive literal substring; offset/limit pages matches (default 50; null means all remaining). Returns original help lines, coverage and current tool identity. Requires Linux, REA_SIGROK_COMMAND and prlimit. Each call probes again; decoder modules are trusted but not fully fingerprinted. No recording, target, hardware scan or acquisition.",
    inputSchema: inspectSignalDecodersInputSchema,
    outputSchema: evidenceResultOf(signalDecodersSchema),
    examples: [
      { title: "Find installed UART decoders", input: { query: "uart" } },
      {
        title: "Read the installed UART baud-rate option",
        input: { decoder: "uart", query: "baud" },
      },
    ],
  },
  {
    name: "decode_signal_recording",
    ...toolContractMetadata("decode_signal_recording"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Decode a saved logic/signal recording with an explicitly selected sigrok decoder stack, channels and options. Returns literal text, sample ranges, diagnostics, source/tool identity and coverage. line_offset/line_limit page display lines (default 50; null means all remaining), not annotations or samples; paging does not shorten decoding. Requires Linux, sigrok-cli 0.7.2 through absolute REA_SIGROK_COMMAND, and prlimit. No acquisition or device communication. Empty output does not prove absent traffic.",
    inputSchema: decodeSignalRecordingInputSchema,
    outputSchema: evidenceResultOf(signalRecordingSchema),
    examples: [
      {
        title: "Decode recorded UART RX bytes",
        input: {
          path: "/artifacts/uart.vcd",
          input_format: "vcd",
          decoders: "uart:rx=RX:baudrate=9600",
          annotations: "uart=rx-data",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
